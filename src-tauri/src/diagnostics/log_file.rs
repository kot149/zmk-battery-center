use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const RECORD_LIMIT: usize = 32 * 1024;

pub(super) struct LogFile {
    dir: PathBuf,
    name: String,
    max_size: u64,
    file: Option<File>,
    size: u64,
    pending: Vec<u8>,
    truncated: bool,
    lock: Arc<Mutex<()>>,
}

pub(super) fn is_archive(name: &str, base: &str) -> bool {
    (1..=4).any(|n| name == format!("{base}.{n}.log"))
        || name
            .strip_prefix(&format!("{base}_"))
            .is_some_and(|suffix| {
                let date = suffix
                    .strip_suffix(".log.bak")
                    .or_else(|| suffix.strip_suffix(".log"));
                date.is_some_and(|s| {
                    s.len() == 19
                        && s.bytes()
                            .all(|b| b.is_ascii_digit() || b == b'-' || b == b'_')
                })
            })
}

impl LogFile {
    pub(super) fn new(
        dir: PathBuf,
        name: &str,
        max_size: u64,
        lock: Arc<Mutex<()>>,
    ) -> io::Result<Self> {
        fs::create_dir_all(&dir)?;
        let mut writer = Self {
            dir,
            name: name.into(),
            max_size,
            file: None,
            size: 0,
            pending: Vec::new(),
            truncated: false,
            lock,
        };
        writer.prune_archives(4)?;
        writer.open()?;
        Ok(writer)
    }

    fn path(&self, generation: usize) -> PathBuf {
        if generation == 0 {
            self.dir.join(format!("{}.log", self.name))
        } else {
            self.dir.join(format!("{}.{generation}.log", self.name))
        }
    }

    fn open(&mut self) -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(self.path(0))?;
        self.size = file.metadata()?.len();
        self.file = Some(file);
        Ok(())
    }

    fn prune_archives(&self, keep: usize) -> io::Result<()> {
        let mut files = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            if is_archive(&entry.file_name().to_string_lossy(), &self.name)
                && entry.file_type()?.is_file()
            {
                let metadata = entry.metadata()?;
                if metadata.len() > self.max_size {
                    fs::remove_file(entry.path())?;
                } else {
                    files.push((metadata.modified()?, entry.path()));
                }
            }
        }
        files.sort();
        let remove = files.len().saturating_sub(keep);
        for (_, path) in files.into_iter().take(remove) {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file.take();
        match fs::remove_file(self.path(4)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        self.prune_archives(3)?;
        for generation in (1..=3).rev() {
            let from = self.path(generation);
            if from.exists() {
                fs::rename(from, self.path(generation + 1))?;
            }
        }
        fs::rename(self.path(0), self.path(1))?;
        self.open()
    }
}

impl Write for LogFile {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let remaining = RECORD_LIMIT.saturating_sub(self.pending.len());
        self.pending
            .extend_from_slice(&bytes[..bytes.len().min(remaining)]);
        self.truncated |= bytes.len() > remaining;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        if self.truncated {
            const MARKER: &[u8] = b" [truncated]\n";
            let mut end = self.pending.len().saturating_sub(MARKER.len());
            while end > 0 && (self.pending[end] & 0xc0) == 0x80 {
                end -= 1;
            }
            self.pending.truncate(end);
            self.pending.extend_from_slice(MARKER);
        }
        let lock = self.lock.clone();
        let _guard = lock.lock().map_err(|e| io::Error::other(e.to_string()))?;
        let result = (|| {
            if self.file.is_none() {
                self.open()?;
            }
            if self.size > 0 && self.size + self.pending.len() as u64 > self.max_size {
                self.rotate()?;
            }
            let file = self.file.as_mut().unwrap();
            file.write_all(&self.pending)?;
            self.size = file.metadata()?.len();
            file.flush()
        })();
        self.pending.clear();
        self.truncated = false;
        if result.is_err() {
            self.file.take();
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rapid_rotation_keeps_five_bounded_files_and_the_newest_record() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = LogFile::new(dir.path().into(), "test", 64, Arc::default()).unwrap();
        for n in 0..100 {
            writeln!(writer, "record={n:03} abcdefghijklmnopqrstuvwxyz").unwrap();
            writer.flush().unwrap();
            let files: Vec<_> = fs::read_dir(dir.path())
                .unwrap()
                .map(Result::unwrap)
                .collect();
            assert!(files.len() <= 5);
            assert!(files.iter().all(|f| f.metadata().unwrap().len() <= 64));
        }
        assert!(
            fs::read_to_string(writer.path(0))
                .unwrap()
                .contains("record=099")
        );
        drop(writer);
        let mut writer = LogFile::new(dir.path().into(), "test", 64, Arc::default()).unwrap();
        writeln!(writer, "restart").unwrap();
        writer.flush().unwrap();
        assert!(
            fs::read_to_string(writer.path(0))
                .unwrap()
                .contains("restart")
        );
    }

    #[test]
    fn oversized_unicode_records_are_bounded_and_marked() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = LogFile::new(
            dir.path().into(),
            "test",
            RECORD_LIMIT as u64,
            Arc::default(),
        )
        .unwrap();
        writeln!(writer, "{}", "日".repeat(RECORD_LIMIT)).unwrap();
        writer.flush().unwrap();
        let output = fs::read_to_string(writer.path(0)).unwrap();
        assert!(output.len() <= RECORD_LIMIT);
        assert!(output.ends_with(" [truncated]\n"));
    }

    #[test]
    fn legacy_archives_and_backups_count_toward_the_limit_but_other_files_are_untouched() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..9 {
            fs::write(
                dir.path()
                    .join(format!("test_2026-10-28_12-00-0{n}.log.bak")),
                "old\n",
            )
            .unwrap();
        }
        fs::write(dir.path().join("unrelated.txt"), "keep").unwrap();
        let mut writer = LogFile::new(dir.path().into(), "test", 64, Arc::default()).unwrap();
        for n in 0..10 {
            writeln!(writer, "record={n} abcdefghijklmnopqrstuvwxyz").unwrap();
            writer.flush().unwrap();
        }
        assert!(fs::read_dir(dir.path()).unwrap().count() <= 6);
        assert_eq!(
            fs::read_to_string(dir.path().join("unrelated.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn failed_rotation_is_reported_and_the_writer_can_recover() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = LogFile::new(dir.path().into(), "test", 10, Arc::default()).unwrap();
        writeln!(writer, "first").unwrap();
        writer.flush().unwrap();
        fs::create_dir(writer.path(4)).unwrap();
        writeln!(writer, "second").unwrap();
        assert!(writer.flush().is_err());
        assert_eq!(fs::read_to_string(writer.path(0)).unwrap(), "first\n");
        fs::remove_dir(writer.path(4)).unwrap();
        writeln!(writer, "third").unwrap();
        writer.flush().unwrap();
        assert_eq!(fs::read_to_string(writer.path(0)).unwrap(), "third\n");
    }

    #[test]
    fn plugin_dispatch_extension_flushes_complete_records() {
        let dir = tempfile::tempdir().unwrap();
        let writer = LogFile::new(dir.path().into(), "test", 32, Arc::default()).unwrap();
        let (_, logger) = fern::Dispatch::new()
            .chain(fern::Output::writer(Box::new(writer), "\n"))
            .into_log();
        for _ in 0..100 {
            logger.log(
                &log::Record::builder()
                    .args(format_args!("日本語 record"))
                    .level(log::Level::Info)
                    .build(),
            );
        }
        logger.flush();
        let files: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(files.len(), 5);
        assert!(files.iter().all(|entry| {
            let text = fs::read_to_string(entry.path()).unwrap();
            text.len() <= 32 && text.ends_with('\n') && text.contains("日本語 record")
        }));
    }

    #[test]
    fn production_limits_hold_for_repeated_two_mib_rotations() {
        let dir = tempfile::tempdir().unwrap();
        let limit = 2 * 1024 * 1024;
        let mut writer = LogFile::new(dir.path().into(), "test", limit, Arc::default()).unwrap();
        let padding = "x".repeat(RECORD_LIMIT - 100);
        for n in 0..400 {
            writeln!(writer, "record={n:03} {padding}").unwrap();
            writer.flush().unwrap();
        }
        let files: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(files.len(), 5);
        assert!(files.iter().all(|f| f.metadata().unwrap().len() <= limit));
        assert!(
            files
                .iter()
                .map(|f| f.metadata().unwrap().len())
                .sum::<u64>()
                <= 5 * limit
        );
        assert!(
            fs::read_to_string(writer.path(0))
                .unwrap()
                .contains("record=399")
        );
    }
}

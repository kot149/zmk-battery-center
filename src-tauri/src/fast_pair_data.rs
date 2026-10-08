use bluest::AdvertisementData;
use uuid::Uuid;

const SERVICE: Uuid = Uuid::from_u128(0x0000fe2c_0000_1000_8000_00805f9b34fb);

pub(crate) fn battery_levels(advertisement: &AdvertisementData) -> Option<[Option<u8>; 3]> {
    advertisement.service_data.iter().find_map(|(uuid, data)| {
        // Bluest 0.6.9 reads Windows 16-bit service-data UUIDs as big endian.
        let windows_uuid = cfg!(target_os = "windows")
            && *uuid == Uuid::from_u128(0x00002cfe_0000_1000_8000_00805f9b34fb);
        (*uuid == SERVICE || windows_uuid)
            .then(|| decode_battery(data))
            .flatten()
    })
}

// https://developers.google.com/nearby/fast-pair/specifications/extensions/batterynotification
pub(crate) fn decode_battery(data: &[u8]) -> Option<[Option<u8>; 3]> {
    if !matches!(data.first(), Some(0x00 | 0x10)) {
        return None;
    }
    let mut fields = &data[1..];
    let mut battery = None;
    while let Some((&header, rest)) = fields.split_first() {
        let length = usize::from(header >> 4);
        let value = rest.get(..length)?;
        if matches!(header & 0x0f, 3 | 4) {
            if length != 3 || battery.is_some() {
                return None;
            }
            let mut levels = [None; 3];
            for (level, raw) in levels.iter_mut().zip(value) {
                *level = match raw & 0x7f {
                    percent @ 0..=100 => Some(percent),
                    127 => None,
                    _ => return None,
                };
            }
            battery = Some(levels);
        }
        fields = &rest[length..];
    }
    battery
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_earbuds_and_unknown_case() {
        assert_eq!(
            decode_battery(&[0x10, 0x30, 0, 0, 0, 0x21, 0, 0, 0x34, 52, 52, 127]),
            Some([Some(52), Some(52), None])
        );
    }

    #[test]
    fn handles_charging_show_ui_and_zero_percent() {
        assert_eq!(
            decode_battery(&[0, 0x33, 0x80, 0xe4, 0xff]),
            Some([Some(0), Some(100), None])
        );
    }

    #[test]
    fn skips_other_fields_without_interpreting_them_as_batteries() {
        assert_eq!(decode_battery(&[0, 0x40, 0x34, 52, 52, 52]), None);
        assert_eq!(
            decode_battery(&[0, 0x15, 88, 0x34, 10, 20, 30, 0x11, 0]),
            Some([Some(10), Some(20), Some(30)])
        );
    }

    #[test]
    fn rejects_malformed_packets() {
        for data in [
            &[][..],
            &[0],
            &[0, 0x34, 52],
            &[0, 0x34, 101, 52, 52],
            &[0x20, 0x34, 52, 52, 52],
            &[0, 0xf0, 0x34, 52, 52, 52],
            &[0, 0x24, 52, 52],
            &[0, 0x34, 52, 52, 52, 0xf0],
            &[0, 0x34, 1, 2, 3, 0x33, 4, 5, 6],
        ] {
            assert_eq!(decode_battery(data), None, "{data:?}");
        }
    }

    #[test]
    fn only_decodes_fast_pair_service_data() {
        let mut advertisement = AdvertisementData {
            local_name: None,
            manufacturer_data: None,
            services: vec![],
            service_data: Default::default(),
            tx_power_level: None,
            is_connectable: true,
        };
        advertisement
            .service_data
            .insert(Uuid::nil(), vec![0, 0x34, 1, 2, 3]);
        assert_eq!(battery_levels(&advertisement), None);
        advertisement
            .service_data
            .insert(SERVICE, vec![0, 0x34, 1, 2, 3]);
        assert_eq!(
            battery_levels(&advertisement),
            Some([Some(1), Some(2), Some(3)])
        );
        advertisement.service_data.clear();
        advertisement.service_data.insert(
            Uuid::from_u128(0x00002cfe_0000_1000_8000_00805f9b34fb),
            vec![0, 0x34, 1, 2, 3],
        );
        assert_eq!(
            battery_levels(&advertisement),
            if cfg!(target_os = "windows") {
                Some([Some(1), Some(2), Some(3)])
            } else {
                None
            }
        );
    }
}

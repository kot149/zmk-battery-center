import { openUrl } from "@tauri-apps/plugin-opener";
import type { UpdateInfo } from "@/utils/update";

type UpdateBannerProps = {
  update: UpdateInfo;
  onDismiss: () => void;
};

export default function UpdateBanner({ update, onDismiss }: UpdateBannerProps) {
  return (
    <div className="mx-4 my-1 flex items-center gap-2 rounded-lg bg-emerald-700 px-3 py-2 text-sm text-white hover:bg-emerald-800">
      <button
        type="button"
        aria-label={`Open release v${update.version}`}
        className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        onClick={() => void openUrl(update.releaseUrl)}
      >
        zmk-battery-center v{update.version} is available
      </button>
      <button
        type="button"
        aria-label={`Dismiss update v${update.version}`}
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-lg leading-none hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        onClick={onDismiss}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

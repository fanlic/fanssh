import { Icon } from "./Icon";

interface Props {
  sftpOpen: boolean;
  dockerOpen: boolean;
  aiOpen: boolean;
  onToggleSftp: () => void;
  onToggleDocker: () => void;
  onToggleAi: () => void;
}

/** 终端区与 AI 面板之间的活动栏。 */
export function ActivityBar({
  sftpOpen,
  dockerOpen,
  aiOpen,
  onToggleSftp,
  onToggleDocker,
  onToggleAi,
}: Props) {
  return (
    <nav className="activitybar" aria-label="活动栏">
      <button
        className={`ab-btn${sftpOpen ? " is-active" : ""}`}
        title={sftpOpen ? "关闭 SFTP" : "打开 SFTP"}
        aria-pressed={sftpOpen}
        onClick={onToggleSftp}
      >
        <Icon name="folder" size={17} />
      </button>
      <button
        className={`ab-btn${dockerOpen ? " is-active" : ""}`}
        title={dockerOpen ? "关闭 Docker" : "打开 Docker"}
        aria-pressed={dockerOpen}
        onClick={onToggleDocker}
      >
        <Icon name="docker" size={17} />
      </button>
      <button
        className={`ab-btn${aiOpen ? " is-active" : ""}`}
        title={aiOpen ? "收起 AI 面板 (Ctrl J)" : "展开 AI 面板 (Ctrl J)"}
        aria-pressed={aiOpen}
        onClick={onToggleAi}
      >
        <Icon name={aiOpen ? "panel" : "spark"} size={17} />
      </button>
    </nav>
  );
}

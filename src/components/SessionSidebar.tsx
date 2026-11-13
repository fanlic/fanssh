import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { errorText, profileDelete } from "../api";
import { useAppStore } from "../store";
import type { Profile } from "../types";
import { Icon } from "./Icon";

interface Props {
  onNew: () => void;
  onEdit: (profile: Profile) => void;
  onImport: () => void;
  onExport: () => void;
  onRdp: (profile: Profile) => void;
  onNotice: (message: string, kind?: "info" | "error") => void;
  query: string;
  onQueryChange: (value: string) => void;
}

type ProtoFilter = "ssh" | "rdp" | "serial";

const PROTO_LABEL: Record<ProtoFilter, string> = { ssh: "SSH", rdp: "RDP", serial: "串口" };
const PROTO_TAG: Record<ProtoFilter, string> = { ssh: "SSH", rdp: "RDP", serial: "SER" };
const ALL_PROTOS: ProtoFilter[] = ["ssh", "serial", "rdp"];

export function SessionSidebar({
  onNew,
  onEdit,
  onImport,
  onExport,
  onRdp,
  onNotice,
  query,
  onQueryChange,
}: Props) {
  const profiles = useAppStore((s) => s.profiles);
  const loading = useAppStore((s) => s.profilesLoading);
  const error = useAppStore((s) => s.profilesError);
  const tabs = useAppStore((s) => s.tabs);
  const openProfileTab = useAppStore((s) => s.openProfileTab);
  const setSftpProfileId = useAppStore((s) => s.setSftpProfileId);
  const loadProfiles = useAppStore((s) => s.loadProfiles);

  const [enabled, setEnabled] = useState<Record<ProtoFilter, boolean>>({
    ssh: true,
    serial: true,
    rdp: true,
  });
  const [filterOpen, setFilterOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const filterRef = useRef<HTMLDivElement | null>(null);
  const ctxRef = useRef<HTMLDivElement | null>(null);

  // 点击外部 / Esc 关闭协议筛选菜单
  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (event: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(event.target as Node)) {
        setFilterOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

  // 点击外部 / Esc / 滚动 / 窗口变化时关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onDown = (event: MouseEvent) => {
      if (ctxRef.current && ctxRef.current.contains(event.target as Node)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [ctxMenu]);

  const keyword = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      profiles.filter((profile) => {
        if (!keyword) return true;
        return (
          profile.name.toLowerCase().includes(keyword) ||
          profile.target.host.toLowerCase().includes(keyword) ||
          (profile.group ?? "").toLowerCase().includes(keyword) ||
          profile.protocol.includes(keyword) ||
          (profile.protocol === "rdp"
            ? "rdp 远程桌面"
            : profile.protocol === "serial"
              ? "串口 serial"
              : "ssh"
          ).includes(keyword) ||
          (profile.protocol === "serial"
            ? `${profile.options.serial?.port ?? ""} ${profile.options.serial?.baud_rate ?? ""}`
                .toLowerCase()
                .includes(keyword)
            : false) ||
          profile.tags.some((tag) => tag.toLowerCase().includes(keyword))
        );
      }),
    [profiles, keyword],
  );

  const matchCount = useMemo(
    () => ({
      ssh: matches.filter((profile) => profile.protocol === "ssh").length,
      rdp: matches.filter((profile) => profile.protocol === "rdp").length,
      serial: matches.filter((profile) => profile.protocol === "serial").length,
    }),
    [matches],
  );

  const selectedProtos = ALL_PROTOS.filter((item) => enabled[item]);
  const allSelected = selectedProtos.length === ALL_PROTOS.length;

  const visible = useMemo(
    () => matches.filter((profile) => enabled[profile.protocol]),
    [matches, enabled],
  );

  const groups = useMemo(() => {
    const map = new Map<string, Profile[]>();
    for (const profile of visible) {
      const key = profile.group?.trim() || "未分组";
      const list = map.get(key) ?? [];
      list.push(profile);
      map.set(key, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visible]);

  const activeProfileIds = useMemo(
    () => new Set(tabs.flatMap((tab) => tab.panes.map((pane) => pane.profileId))),
    [tabs],
  );

  const handleConnect = (profile: Profile) => {
    if (profile.protocol === "rdp") {
      onRdp(profile);
    } else {
      openProfileTab(profile);
    }
  };

  const handleDelete = async (profile: Profile) => {
    if (!window.confirm(`确定删除「${profile.name}」？关联的凭据也会一并清理。`)) return;
    try {
      await profileDelete(profile.id);
      await loadProfiles();
      onNotice(`已删除 ${profile.name}`);
    } catch (err) {
      onNotice(errorText(err), "error");
    }
  };

  const toggleProto = (item: ProtoFilter) => {
    setEnabled((prev) => {
      const next = { ...prev, [item]: !prev[item] };
      // 至少保留一个协议，禁止取消最后一项
      if (!ALL_PROTOS.some((key) => next[key])) return prev;
      return next;
    });
  };

  const selectAll = () => setEnabled({ ssh: true, serial: true, rdp: true });

  const openContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    // 协议筛选菜单内部右键不重复弹菜单
    if (filterRef.current?.contains(event.target as Node)) return;
    const width = 188;
    const height = 116;
    setCtxMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    });
  };

  const visibleCount = visible.length;
  const filterLabel = `${allSelected ? "全部" : selectedProtos.map((item) => PROTO_LABEL[item]).join(" + ")} · ${visibleCount}`;
  const emptyVariant: "none" | "search" | "hidden" | null =
    profiles.length === 0
      ? "none"
      : visibleCount > 0 || loading || error
        ? null
        : keyword
          ? matches.length > 0
            ? "hidden"
            : "search"
          : "hidden";

  return (
    <aside className="sidebar" onContextMenu={openContextMenu}>
      <div className="sb-head">
        <span className="sb-title">会话</span>
        <span className="sb-count">{profiles.length}</span>
        <div className="spacer" />
        <button className="icon-btn sm" title="新建连接" onClick={onNew}>
          <Icon name="plus" size={14} />
        </button>
      </div>

      <div className="sb-actions">
        <button className="btn-primary" onClick={onNew}>
          <Icon name="plus" size={13} />
          新建连接
        </button>
        <button className="btn-ghost" title="从加密配置导入（.fansshx / 旧版 .json）" onClick={onImport}>
          <Icon name="import" size={13} />
          导入
        </button>
        <button className="icon-btn sm" title="导出加密配置（.fansshx）" onClick={onExport}>
          <Icon name="export" size={14} />
        </button>
      </div>

      <div className="sb-list">
        {loading && <div className="sb-hint">加载中…</div>}
        {error && <div className="sb-hint err">{error}</div>}
        {groups.map(([group, list]) => {
          const isCollapsed = collapsed[group] ?? false;
          return (
            <div className="group" key={group}>
              <button
                className={`group-head${isCollapsed ? " is-collapsed" : ""}`}
                onClick={() => setCollapsed((prev) => ({ ...prev, [group]: !isCollapsed }))}
              >
                <Icon name="chev" size={11} className="g-caret" />
                <span className="g-name">{group}</span>
                <span className="g-count">{list.length}</span>
              </button>
              {!isCollapsed &&
                list.map((profile) => (
                  <div
                    key={profile.id}
                    className={`session${activeProfileIds.has(profile.id) ? " is-open" : ""}`}
                    onDoubleClick={() => handleConnect(profile)}
                    title={`双击连接 ${
                      profile.protocol === "serial"
                        ? `${profile.target.host} @ ${profile.options.serial?.baud_rate ?? ""}`
                        : `${profile.target.user ? `${profile.target.user}@` : ""}${profile.target.host}:${profile.target.port}`
                    }`}
                  >
                    <span className={`proto-tag ${profile.protocol}`}>
                      {PROTO_TAG[profile.protocol]}
                    </span>
                    <span className="s-name">{profile.name}</span>
                    <span className="s-host">{profile.target.host}</span>
                    <span className={`s-dot ${activeProfileIds.has(profile.id) ? "on" : ""}`} />
                    <div className="s-actions">
                      <button className="mini" title="连接" onClick={() => handleConnect(profile)}>
                        <Icon name="play" size={12} />
                      </button>
                      {profile.protocol === "ssh" && (
                        <button
                          className="mini"
                          title="SFTP 文件"
                          onClick={() => setSftpProfileId(profile.id)}
                        >
                          <Icon name="transfer" size={12} />
                        </button>
                      )}
                      <button className="mini" title="编辑" onClick={() => onEdit(profile)}>
                        <Icon name="edit" size={12} />
                      </button>
                      <button
                        className="mini danger"
                        title="删除"
                        onClick={() => handleDelete(profile)}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          );
        })}

        {emptyVariant === "none" && (
          <div className="sb-empty">
            <span className="empty-icon">
              <Icon name="folder" size={18} />
            </span>
            <div className="empty-title">还没有服务器配置</div>
            <div className="empty-desc">添加第一台 SSH / 串口 / RDP 设备后即可双击连接</div>
            <button className="btn-primary sm" onClick={onNew}>
              新建连接
            </button>
          </div>
        )}
        {emptyVariant === "search" && (
          <div className="sb-empty">
            <span className="empty-icon">
              <Icon name="search" size={18} />
            </span>
            <div className="empty-title">没有匹配的会话</div>
            <div className="empty-desc">试试更短的关键词，或切换协议</div>
            <button className="btn-ghost sm" onClick={() => onQueryChange("")}>
              清除搜索
            </button>
          </div>
        )}
        {emptyVariant === "hidden" && (
          <div className="sb-empty">
            <span className="empty-icon">
              <Icon name="filter" size={18} />
            </span>
            <div className="empty-title">
              {keyword ? "筛选隐藏了搜索结果" : "当前筛选已隐藏全部会话"}
            </div>
            <div className="empty-desc">
              {keyword
                ? `「${query.trim()}」匹配的会话都在未勾选的协议里`
                : "勾选更多协议，或直接显示全部协议"}
            </div>
            <button className="btn-ghost sm" onClick={selectAll}>
              显示全部协议
            </button>
          </div>
        )}
      </div>

      <div className="sb-filter" ref={filterRef}>
        <button
          className={`pf-btn${filterOpen ? " is-open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={filterOpen}
          title="按协议筛选会话"
          onClick={() => setFilterOpen((open) => !open)}
        >
          <Icon name="filter" size={12} />
          <span className="pf-label">{filterLabel}</span>
          <Icon name="chev" size={11} className="pf-caret" />
        </button>

        {filterOpen && (
          <div className="proto-menu" role="menu" aria-label="协议筛选">
            <label className="pf-row">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={allSelected}
                title={allSelected ? "已全选；至少保留一个协议" : "勾选全部协议"}
                onChange={selectAll}
              />
              <span className="pf-name">全选</span>
              <span className="pf-count">{matches.length}</span>
            </label>
            <div className="pf-sep" />
            {ALL_PROTOS.map((item) => (
              <label className="pf-row" key={item}>
                <input
                  type="checkbox"
                  checked={enabled[item]}
                  disabled={enabled[item] && selectedProtos.length === 1}
                  title={
                    enabled[item] && selectedProtos.length === 1
                      ? "至少保留一个协议"
                      : `显示 / 隐藏 ${PROTO_LABEL[item]} 会话`
                  }
                  onChange={() => toggleProto(item)}
                />
                <span className={`proto-tag ${item}`}>{PROTO_TAG[item]}</span>
                <span className="pf-name">{PROTO_LABEL[item]}</span>
                <span className="pf-count">{matchCount[item]}</span>
              </label>
            ))}
            <div className="pf-note">至少保留一个协议；与顶部搜索取交集</div>
          </div>
        )}
      </div>

      <div className="sb-foot">
        <Icon name="lock" size={11} />
        <span>凭据已加密，与配置分开存储</span>
      </div>

      {ctxMenu && (
        <div
          ref={ctxRef}
          className="ctx-menu"
          role="menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              setCtxMenu(null);
              onNew();
            }}
          >
            <Icon name="plus" size={13} />
            新建连接
          </button>
          <button
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              setCtxMenu(null);
              onImport();
            }}
          >
            <Icon name="import" size={13} />
            导入配置…
          </button>
          <button
            className="ctx-item"
            role="menuitem"
            onClick={() => {
              setCtxMenu(null);
              onExport();
            }}
          >
            <Icon name="export" size={13} />
            导出加密配置…
          </button>
        </div>
      )}
    </aside>
  );
}

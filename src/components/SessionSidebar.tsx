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
  onOpenTunnel: (profile: Profile) => void;
  onNotice: (message: string, kind?: "info" | "error") => void;
  query: string;
  onQueryChange: (value: string) => void;
  /** 顶部协议 tab 当前选中的协议，用于同步侧栏过滤与新建按钮文案。 */
  proto?: ProtoFilter;
  onCollapse?: () => void;
}

type ProtoFilter = "ssh" | "rdp" | "serial" | "telnet" | "vnc" | "tunnel";

const PROTO_LABEL: Record<ProtoFilter, string> = {
  ssh: "SSH",
  rdp: "RDP",
  serial: "串口",
  telnet: "Telnet",
  vnc: "VNC",
  tunnel: "隧道",
};
const PROTO_TAG: Record<ProtoFilter, string> = {
  ssh: "SSH",
  rdp: "RDP",
  serial: "SER",
  telnet: "TEL",
  vnc: "VNC",
  tunnel: "TUN",
};
const ALL_PROTOS: ProtoFilter[] = ["ssh", "serial", "rdp", "telnet", "vnc", "tunnel"];

export function SessionSidebar({
  onNew,
  onEdit,
  onImport,
  onExport,
  onRdp,
  onOpenTunnel,
  onNotice,
  query,
  onQueryChange,
  proto,
  onCollapse,
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
    telnet: true,
    vnc: true,
    tunnel: true,
  });
  // 顶部协议 tab 切换时，把侧栏过滤同步为单协议；底部勾选菜单仍可再改。
  useEffect(() => {
    if (!proto) return;
    setEnabled({
      ssh: proto === "ssh",
      serial: proto === "serial",
      rdp: proto === "rdp",
      telnet: proto === "telnet",
      vnc: proto === "vnc",
      tunnel: proto === "tunnel",
    });
  }, [proto]);
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
              : profile.protocol === "tunnel"
                ? "隧道 tunnel 端口转发"
                : profile.protocol === "telnet"
                  ? "telnet 明文"
                  : profile.protocol === "vnc"
                    ? "vnc 远程桌面 rfb"
                    : "ssh"
          ).includes(keyword) ||
          (profile.protocol === "tunnel"
            ? `${profile.options.tunnel?.routes.length ?? 0} 条路由`
                .toLowerCase()
                .includes(keyword)
            : false) ||
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
      telnet: matches.filter((profile) => profile.protocol === "telnet").length,
      vnc: matches.filter((profile) => profile.protocol === "vnc").length,
      tunnel: matches.filter((profile) => profile.protocol === "tunnel").length,
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
    } else if (profile.protocol === "tunnel") {
      onOpenTunnel(profile);
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

  const selectAll = () =>
    setEnabled({ ssh: true, serial: true, rdp: true, telnet: true, vnc: true, tunnel: true });

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
  const currentLabel = proto ? PROTO_LABEL[proto] : "新建";
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
        <button className="sb-collapse" title="收起会话列表 (Ctrl Shift B)" onClick={onCollapse}>
          <Icon name="split" size={14} />
          <span>收起</span>
        </button>
        <div className="spacer" />
        <button
          className="sb-tool"
          title="刷新会话列表"
          onClick={() => void loadProfiles()}
        >
          <Icon name="refresh" size={13} />
        </button>
        <button className="sb-tool sb-tool-primary" onClick={onNew} title={`新建 ${currentLabel} 连接`}>
          <Icon name="plus" size={12} />
          {currentLabel}
        </button>
      </div>

      <div className="sb-search">
        <Icon name="search" size={13} />
        <input
          value={query}
          placeholder="搜索连接、主机、分组"
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query && (
          <button title="清空搜索" onClick={() => onQueryChange("")}>
            <Icon name="x" size={11} />
          </button>
        )}
      </div>

      <div className="sb-list">
        {loading && <div className="sb-hint">加载中…</div>}
        {error && <div className="sb-hint err">{error}</div>}
        <div className="tree-all">
            <Icon name="folder" size={13} />
            <span className="tree-all-name">全部</span>
            <span className="g-count">{visibleCount}</span>
            <div className="spacer" />
            <button
              className="tree-all-gear"
              title="按协议筛选会话"
              onClick={() => setFilterOpen((open) => !open)}
            >
              <Icon name="gear" size={13} />
            </button>
          </div>
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
                    draggable
                    onDragStart={(event) => {
                      // 行内操作按钮不触发拖拽，避免误把连接拖走。
                      if ((event.target as HTMLElement).closest(".s-actions")) {
                        event.preventDefault();
                        return;
                      }
                      event.dataTransfer.setData("application/x-fanssh-profile", profile.id);
                      event.dataTransfer.setData("text/plain", profile.name);
                      event.dataTransfer.effectAllowed = "copy";
                    }}
                    onDoubleClick={() => handleConnect(profile)}
                    title={`双击${
                      profile.protocol === "tunnel"
                        ? `打开隧道面板 · ${profile.options.tunnel?.routes.length ?? 0} 条路由`
                        : profile.protocol === "serial"
                          ? `连接 ${profile.target.host} @ ${profile.options.serial?.baud_rate ?? ""}`
                          : `连接 ${profile.target.user ? `${profile.target.user}@` : ""}${profile.target.host}:${profile.target.port}`
                    }`}
                  >
                    <span className={`s-icon ${profile.protocol}`}>
                      <Icon
                        name={
                          profile.protocol === "serial"
                            ? "plug"
                            : profile.protocol === "rdp"
                              ? "link"
                              : profile.protocol === "tunnel"
                                ? "transfer"
                                : profile.protocol === "vnc"
                                  ? "link"
                                  : "term"
                        }
                        size={13}
                      />
                    </span>
                    <span className="s-name">{profile.name}</span>
                    {profile.protocol !== "ssh" && (
                      <span className={`proto-tag ${profile.protocol}`}>
                        {PROTO_TAG[profile.protocol]}
                      </span>
                    )}
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
            <div className="empty-desc">添加第一台 SSH / Telnet / 串口 / RDP / 隧道 配置后即可双击连接</div>
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

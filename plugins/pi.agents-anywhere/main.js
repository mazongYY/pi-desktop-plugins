/**
 * Agents Anywhere Remote Bridge Plugin for Pi-Desktop
 */
// 本地配置回退存储所需（仅用于 pi.plugin.getSettings 不可用时的兜底）
const fsSync = require("fs");
const path = require("path");
const os = require("os");

// 心跳间隔：官方 accessToken 有效期 900 秒，这里 25 秒一次（与官方默认一致量级）
const HEARTBEAT_INTERVAL_MS = 25000;

/** 与官方客户端 _device_os() 保持一致：macos / windows / linux */
function deviceOS() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 把宿主返回的会话列表规范化成数组。
 * 宿主不同版本可能返回 array、{sessions: []}、{items: []} 或 {data: []}，
 * 统一在这里兼容，避免静默丢数据。
 */
function normalizeSessionList(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") {
    for (const key of ["sessions", "items", "data", "results", "list"]) {
      const value = result[key];
      if (Array.isArray(value)) return value;
    }
    // 单会话对象直接包一层
    if (typeof result.sessionId === "string" || typeof result.id === "string") {
      return [result];
    }
  }
  return [];
}

/** 展开 ~ 为当前用户主目录（与官方 connector 的 Path.expanduser() 对齐）。 */
function expandHome(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

/**
 * 把宿主返回的会话对象映射为官方 session_meta_payload 的字段
 * （见 connector/server/runtime_rpc_payloads.py::session_meta_payload）：
 * sessionId / externalSessionId / runtime / title / cwd / orderingTime / metadata。
 */
function normalizeSessionMeta(item) {
  const source = item && typeof item === "object" ? item : {};
  const id = String(source.sessionId ?? source.session_id ?? source.id ?? "");
  const ordering = source.orderingTime ?? source.updatedAt ?? source.updated_at ?? null;
  return {
    sessionId: id,
    externalSessionId: String(source.externalSessionId ?? id),
    runtime: "pi-desktop",
    runtimeId: "pi-desktop",
    title: String(source.title ?? source.name ?? "Pi Desktop 会话"),
    cwd: String(source.cwd ?? source.path ?? ""),
    orderingTime: typeof ordering === "number" ? ordering : Date.now(),
    metadata: {}
  };
}

/**

/**
 * Runtime Control 2.0 用到的公共构造。
 * 控制台/手机在「配置并启动 Agent」时会依次调用
 * runtime.configSchema → runtime.validateConfig → runtime.start，
 * 缺任何一个都会被标记为「异常」。
 */
function buildConfigSchema() {
  // Pi Desktop 运行时没有可配置项，给一个合法的空对象 schema。
  // 服务端 validate_config_schema 要求根 type 必须为 "object"。
  return { type: "object", properties: {}, additionalProperties: false };
}

/** 官方 _scoped_result 的等价物：应答里要带 runtime（=runtimeType）与 runtimeId。 */
function runtimeScope(params) {
  const runtimeType =
    typeof params?.runtimeType === "string" && params.runtimeType
      ? params.runtimeType
      : "pi-desktop";
  const runtimeId =
    typeof params?.runtimeId === "string" && params.runtimeId ? params.runtimeId : runtimeType;
  return { runtime: runtimeType, runtimeId };
}

/**
 * runtime.capabilities 的能力清单。
 * 字段名与官方 capability_payload 对齐；这里只声明本插件确实实现的能力。
 */
const RUNTIME_CAPABILITIES = [
  "runtime.discover",
  "runtime.config",
  "runtime.start",
  "runtime.stop",
  "runtime.capabilities",
  "session.discover",
  "session.create",
  "session.interrupt",
  "session.interaction.approval"
].map((capabilityId) => ({
  capabilityId,
  version: 1,
  supported: true,
  available: true,
  allowed: true,
  metadata: {}
}));

class DesktopBridge {
  constructor(config) {
    // 由 activate() 注入，供 requestRoot() 读写 rootPath 并持久化
    this.config = config ?? null;
  }

  async getWorkspace() {
    try {
      if (typeof pi.workspace?.get === "function") {
        const ws = await pi.workspace.get();
        return ws ? { path: ws.path, name: ws.name } : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 列出「可通信」的 Agent 会话。
   * 宿主只向插件暴露 session/collaboration/list（没有 session/list 或 project/list），
   * 按宿主描述它返回的是 "bounded, communicable Agent sessions" —— 即通过协作
   * 创建/关联的会话，而不是桌面上全部历史会话。
   *
   * 宿主的实际返回形状未在文档中固定，这里对 array / {sessions} / {items} 全部兼容，
   * 避免因形状不符而静默返回空列表（那会让手机端看起来「项目没同步过来」）。
   */
  async listSessions() {
    try {
      const result = await pi.desktop.invoke({
        operation: "session/collaboration/list",
        args: [{}]
      });

      const list = normalizeSessionList(result);
      console.log(
        `[Anywhere:Bridge] session/collaboration/list 返回 ${list.length} 条会话；原始形状: ` +
          (Array.isArray(result) ? "array" : typeof result === "object" && result !== null
            ? `object(keys=${Object.keys(result).join(",")})`
            : typeof result)
      );
      return list;
    } catch (e) {
      console.error("[Anywhere:Bridge] listSessions error:", e);
      return [];
    }
  }

  /** 插件沙箱允许读取的根目录：即 Pi Desktop 当前打开的工作区。 */
  /**
   * 插件沙箱允许读取的根目录。
   * manifest 声明 fs.read.root = "userSelected"，因此根目录是用户在 Pi Desktop
   * 面板上通过「选择项目根目录」显式授权的那一个（可为主目录 ~ 或任意项目父目录）。
   * 该授权保存在宿主内存中，应用重启后需要重新选择一次。
   */
  async getAllowedRoot() {
    return this.config?.rootPath || null;
  }

  /** 在桌面端弹出原生目录选择器，授权插件可读取的根目录。 */
  async requestRoot() {
    if (typeof pi.fs?.requestDirectory !== "function") {
      throw new Error("当前宿主不支持 fs.requestDirectory");
    }
    const picked = await pi.fs.requestDirectory();
    if (!picked?.path) return { ok: false, cancelled: true };
    this.config.rootPath = picked.path;
    this.config.rootName = picked.name || path.basename(picked.path);
    await writeStoredConfig(this.config);
    return { ok: true, path: this.config.rootPath, name: this.config.rootName };
  }

  /**
   * 实现 Agents Anywhere 的 fs.readDir 契约
   * （官方实现见 connector/local/file_ops.py::read_dir）：
   *   入参 {root, path}，root 为项目根（可为 ~），path 相对 root 或为绝对路径。
   *   返回 {path, entries:[{name,path,type,size}], truncated, targetPath, targetType}
   *
   * 底层用 pi.fs.list，路径必须落在已授权的根目录内；越界的请求回退到根目录，
   * 并通过 path/targetPath 如实告知手机端实际列出的位置。
   */
  async readDir(params) {
    const allowedRoot = await this.getAllowedRoot();
    if (!allowedRoot) {
      throw new Error(
        "尚未授权目录访问：请在 Pi Desktop 的「远程助手」面板点击「选择项目根目录」，授权后再重试"
      );
    }

    const root = expandHome(params?.root ?? params?.cwd ?? allowedRoot);
    const raw = params?.path;
    const target = raw === undefined || raw === null || raw === ""
      ? root
      : path.isAbsolute(String(raw))
        ? String(raw)
        : path.join(root, String(raw));

    let rel = path.relative(allowedRoot, target);
    const outside = rel.startsWith("..") || path.isAbsolute(rel);
    if (outside) rel = "";

    // 与官方 read_dir 一致：目标不可读（不存在/是文件/无权限）时，回退到最近的
    // 可用父目录并把实际列出的位置如实返回，而不是直接报错。
    let effectiveRel = rel;
    let rawEntries = null;
    for (;;) {
      try {
        rawEntries = await pi.fs.list(effectiveRel || "");
        break;
      } catch (e) {
        if (!effectiveRel) {
          console.warn("[Anywhere:Bridge] 连授权根都无法列出:", e?.message || e);
          rawEntries = [];
          break;
        }
        effectiveRel = effectiveRel.includes("/")
          ? effectiveRel.slice(0, effectiveRel.lastIndexOf("/"))
          : "";
      }
    }

    const listedDir = effectiveRel ? path.join(allowedRoot, effectiveRel) : allowedRoot;
    const fellBack = effectiveRel !== rel;
    const entries = (Array.isArray(rawEntries) ? rawEntries : []).map((entry) => ({
      name: entry?.name ?? "",
      path: path.join(allowedRoot, entry?.path ?? entry?.name ?? ""),
      type: entry?.isDirectory ? "directory" : "file",
      size: typeof entry?.size === "number" ? entry.size : null
    }));

    // 回退时判断原目标究竟是文件还是确实不存在（与官方 targetType 语义对齐）
    let targetType = "directory";
    if (fellBack) {
      const wanted = path.basename(target);
      const hit = entries.find((entry) => entry.name === wanted);
      targetType = hit ? (hit.type === "directory" ? "directory" : "file") : "missing";
    }

    console.log(
      `[Anywhere:Bridge] fs.readDir root=${root} path=${raw ?? "(空)"} → 列出 ${listedDir}` +
        `${outside ? "（请求在授权根之外，已回退）" : ""}` +
        `${fellBack ? `（目标不可读，回退到父目录，targetType=${targetType}）` : ""}，${entries.length} 项`
    );

    return {
      path: listedDir,
      entries,
      truncated: false,
      targetPath: target,
      targetType
    };
  }
  async createSession(title, task) {
    try {
      const result = await pi.desktop.invoke({
        operation: "session/collaboration/spawn",
        args: [{
          title: title || "远程移动会话",
          task: task || "通过 Agents Anywhere 移动端初始化任务",
          notifyOnCompletion: true
        }]
      });
      return result?.sessionId || "";
    } catch (e) {
      console.error("[Anywhere:Bridge] createSession error:", e);
      return "";
    }
  }

  async sendMessage(sessionId, content) {
    try {
      await pi.desktop.invoke({
        operation: "session/collaboration/send",
        args: [{
          sessionId,
          content,
          kind: "message",
          notifyOnCompletion: true
        }]
      });
      return true;
    } catch (e) {
      console.error("[Anywhere:Bridge] sendMessage error:", e);
      return false;
    }
  }

  async cancelTask(sessionId) {
    try {
      await pi.desktop.invoke({
        operation: "session/collaboration/cancel",
        args: [{ sessionId }]
      });
      return true;
    } catch (e) {
      console.error("[Anywhere:Bridge] cancelTask error:", e);
      return false;
    }
  }
}

// 2. Agents Anywhere WebSocket 客户端与 RPC 路由器
class AnywhereClient {
  constructor(config, bridge) {
    this.config = config;
    this.bridge = bridge;
    this.socketId = null;
    this.isConnected = false;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.connecting = false;
    this.tokenRefreshTimer = null;
    this.tokenExpiresIn = 900;
    this.runtimeRunning = false;
    this.logHistory = [];
  }

  log(msg) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${msg}`;
    console.log(`[AgentsAnywhere] ${msg}`);
    this.logHistory.unshift(entry);
    if (this.logHistory.length > 50) this.logHistory.pop();
  }

  getStatus() {
    return {
      connected: this.isConnected,
      serverUrl: this.config.serverUrl,
      deviceName: this.config.deviceName,
      connectorId: this.config.connectorId,
      rootPath: this.config.rootPath || "",
      logs: this.logHistory
    };
  }

  /**
   * 并发保护：activate() 的自动连接与面板保存可能同时触发。
   * 重复连接会让服务端以「同一 connector 已连接」拒绝（close 4409 → HTTP 403），
   * 并且失败方会进入 5 秒无限重试，而成功方仍占着槽位。
   */
  async connect() {
    if (this.isConnected || this.connecting) return;
    this.connecting = true;
    try {
      await this.connectOnce();
    } finally {
      this.connecting = false;
    }
  }

  async connectOnce() {
    if (this.isConnected) return;
    if (!this.config.connectorId || !this.config.connectorToken) {
      this.log("等待配对配置：未提供 Connector ID 或 Token");
      return;
    }

    // 官方协议（见 anywhere-cli 0.1.7.1 connector/runtime.py 及服务端
    // agent_server/api/connector_ingress.py）：
    //   1) POST {server}/api/v2/connector/auth，头 Authorization: Connector <id>:<token>
    //      → 返回 { accessToken, expiresIn }
    //   2) WSS {server}/api/v2/connector/ws，头 Authorization: Bearer <accessToken>
    // 旧实现跳过了 token 交换，直接用 Connector 凭据去连 /connector/v2/rpc，
    // 服务端一律以 403 拒绝。
    const base = this.config.serverUrl.replace(/\/+$/, "");

    let accessToken = "";
    try {
      accessToken = await this.authenticate(base);
    } catch (err) {
      this.log(`鉴权失败: ${err?.message || err}，5秒后自动重试`);
      this.scheduleReconnect();
      return;
    }

    const wsUrl = `${base.replace(/^http/, "ws")}/api/v2/connector/ws`;
    this.log(`正在连接到 Agents Anywhere 服务端: ${wsUrl}`);

    try {
      const res = await pi.net.websocket.connect({
        url: wsUrl,
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "X-Device-OS": deviceOS(),
          "X-Device-Name": encodeURIComponent(this.config.deviceName || "Pi-Desktop")
        },
        timeoutMs: 10000
      });

      this.socketId = res.socketId;
      this.isConnected = true;
      this.log("WebSocket 隧道建立成功，开始注册设备能力...");

      this.setupEventListeners();
      this.startHeartbeat();
      this.scheduleTokenRefresh();
      await this.registerRuntime();
    } catch (err) {
      this.log(`连接失败: ${err?.message || err}，5秒后自动重试`);
      this.scheduleReconnect();
    }
  }

  /** 用 Connector 凭据换取短期 accessToken（有效期 900 秒，需定期刷新）。 */
  async authenticate(base) {
    if (typeof pi.net?.fetch !== "function") {
      throw new Error("宿主不支持 net.fetch，无法完成鉴权");
    }
    const res = await pi.net.fetch({
      url: `${base}/api/v2/connector/auth`,
      method: "POST",
      headers: {
        "Authorization": `Connector ${this.config.connectorId}:${this.config.connectorToken}`,
        "Content-Type": "application/json"
      },
      body: "{}",
      timeoutMs: 10000
    });

    const status = res?.status ?? res?.statusCode;
    if (status === 401) throw new Error("Connector ID 或 Token 无效（服务端返回 401）");
    if (status && status >= 400) throw new Error(`服务端返回 HTTP ${status}`);

    // 宿主 net.fetch 的返回形状是 { status, headers, bodyText }（见 hostApi 实现）
    const text = res?.bodyText ?? res?.body ?? res?.text ?? "";
    const body = typeof text === "string" ? safeJsonParse(text) : text;
    const token = body?.accessToken;
    if (typeof token !== "string" || !token) {
      throw new Error("服务端未返回有效的 accessToken");
    }
    // 记录有效期，供 scheduleTokenRefresh() 在到期前主动换新令牌
    const expiresIn = Number(body?.expiresIn);
    this.tokenExpiresIn = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 900;
    return token;
  }

  /**
   * 在 accessToken 到期前主动重连（连接建立后令牌不再变更，服务端会校验它）。
   * 提前 60 秒换新，避免隧道因令牌过期被服务端以 1008 关闭。
   */
  scheduleTokenRefresh() {
    clearTimeout(this.tokenRefreshTimer);
    const expiresIn = this.tokenExpiresIn || 900;
    const delayMs = Math.max(30, expiresIn - 60) * 1000;
    this.tokenRefreshTimer = setTimeout(async () => {
      this.tokenRefreshTimer = null;
      this.log("accessToken 即将过期，刷新令牌并重建隧道");
      if (this.isConnected) await this.disconnect();
      await this.connect();
    }, delayMs);
  }

  /**
   * 连接建成后的收尾。
   * 原实现会主动发一个名为 runtime.discover 的通知——这是错的：discover 是服务端
   * 向连接器发起的请求，不是连接器上报的通知（服务端通知白名单里也没有它，
   * 见 ConnectorProtocolNotificationHandler.METHODS）。服务端在握手后本就会主动
   * 下发 runtime.discover 请求，因此这里只清理旧状态并记日志。
   */
  async registerRuntime() {
    await this.bridge.getWorkspace();
    this.log("已成功向云端注册 Pi Desktop 运行时，设备已就绪");
  }

  /**
   * 构造 runtimeTypes 描述符。
   *
   * 服务端用 pydantic 严格校验（server/agent_server/core/device_runtime.py）：
   *   RuntimeDiscoveryResponse: extra="forbid", strict=True
   *   RuntimeTypeDescriptor : extra="forbid", strict=True
   * 因此下列字段**全部为必填键**（即使值为 null 也必须出现），多一个键也会被拒：
   *   runtimeType / displayName / description / available / reason / recommended /
   *   recommendationRank / implementationType / configSchema / capabilities /
   *   metadata / instancePolicy / maxInstances
   * 另有两条不变式：
   *   - available=false 时 reason 必须非空
   *   - instancePolicy="single" 时 maxInstances 必须恰好为 1
   *
   * capabilities 的键名沿用官方参考 provider（runtimes/dsh/provider_config.py）。
   */
  buildRuntimeDescriptors() {
    const schema = {
      type: "object",
      properties: {},
      additionalProperties: false
    };
    return [
      {
        runtimeType: "pi-desktop",
        displayName: "Pi Desktop",
        description: "本地 Pi Desktop 工作台（会话、思考流与工具审批）",
        available: true,
        reason: null,
        recommended: true,
        recommendationRank: 0,
        implementationType: "local-service",
        configSchema: {
          revision: 1,
          schema,
          uiSchema: null,
          defaults: {},
          metadata: {}
        },
        capabilities: {
          modelCatalog: false,
          permissionCatalog: false,
          sessionDiscovery: true,
          sessionSnapshot: true,
          sessionState: true,
          sessionNotices: false,
          createAndStartSession: true,
          startTurn: true,
          steerTurn: false,
          interruptTurn: true,
          commands: false,
          interactions: false,
          attachments: false,
          ipc: true
        },
        metadata: {},
        instancePolicy: "single",
        maxInstances: 1
      }
    ];
  }
  setupEventListeners() {
    this._onMessage = async (event) => {
      if (event.socketId !== this.socketId) return;
      try {
        const msg = JSON.parse(event.data);
        await this.handleIncomingRpc(msg);
      } catch (err) {
        console.error("[AgentsAnywhere] Parse JSON error:", err);
      }
    };

    this._onClose = (event) => {
      if (event.socketId !== this.socketId) return;
      this.log("WebSocket 连接已关闭");
      this.cleanup();
      this.scheduleReconnect();
    };

    this._onError = (event) => {
      if (event.socketId !== this.socketId) return;
      this.log(`WebSocket 发生异常: ${JSON.stringify(event.error)}`);
    };

    pi.events.on("net:websocket:message", this._onMessage);
    pi.events.on("net:websocket:close", this._onClose);
    pi.events.on("net:websocket:error", this._onError);
  }

  async handleIncomingRpc(msg) {
    if (!msg || !msg.method) return;
    const { id, method, params } = msg;
    let result = null;
    let error = null;

    this.log(`收到移动端 RPC 请求: ${method}`);

    try {
      switch (method) {
        case "runtime.discover": {
          // 官方契约（runtime_rpc.py::discover_runtimes）：应答键是 runtimeTypes，
          // 且 runtime.discover 不接受任何参数。原实现返回 {runtimes:[{id,name}]}，
          // 手机端读不到 runtimeTypes，于是显示「没有已配置的 Agent」。
          result = { runtimeTypes: this.buildRuntimeDescriptors() };
          this.log(`上报运行时清单: ${result.runtimeTypes.length} 个 Agent`);
          break;
        }

        // ── Runtime Control 2.0：控制台配置/启动 Agent 时调用 ──────────────
        // 契约见 connector/server/runtime_rpc.py。所有应答都带 _scoped_result 附加的
        // runtime（=runtimeType）与 runtimeId 两个字段。

        case "runtime.configSchema": {
          const scope = runtimeScope(params);
          result = {
            configSchema: {
              revision: 1,
              schema: buildConfigSchema(),
              uiSchema: null,
              defaults: {},
              metadata: {}
            },
            ...scope
          };
          break;
        }

        case "runtime.validateConfig": {
          // Pi Desktop 运行时不接受任何自定义配置项，任何输入都视为有效。
          // 缺这个方法会让控制台把 Agent 标记为「异常」。
          const scope = runtimeScope(params);
          result = { valid: true, ...scope };
          this.log(`校验运行时配置: 通过（${scope.runtimeId}）`);
          break;
        }

        case "runtime.config": {
          const scope = runtimeScope(params);
          result = {
            running: this.runtimeRunning,
            config: {
              runtime: scope.runtime,
              runtimeId: scope.runtimeId,
              revision: 1,
              values: {},
              schema: buildConfigSchema(),
              uiSchema: null,
              metadata: {}
            },
            ...scope
          };
          break;
        }

        case "runtime.start": {
          const scope = runtimeScope(params);
          this.runtimeRunning = true;
          result = { status: "running", ...scope };
          this.log(`运行时已启动（${scope.runtimeId}）`);
          break;
        }

        case "runtime.stop": {
          const scope = runtimeScope(params);
          this.runtimeRunning = false;
          result = { status: "stopped", ...scope };
          this.log(`运行时已停止（${scope.runtimeId}）`);
          break;
        }

        case "runtime.capabilities": {
          const scope = runtimeScope(params);
          result = {
            capabilitySet: {
              runtime: scope.runtime,
              runtimeId: scope.runtimeId,
              revision: 1,
              capabilities: RUNTIME_CAPABILITIES,
              metadata: {}
            },
            ...scope
          };
          break;
        }
        case "session.discover": {
          // 官方契约（runtime_session_rpc.discover_sessions）：{sessions, nextCursor}
          const raw = await this.bridge.listSessions();
          result = {
            sessions: (Array.isArray(raw) ? raw : []).map((item) =>
              normalizeSessionMeta(item, this.bridge)
            ),
            nextCursor: null
          };
          this.log(`上报会话清单: ${result.sessions.length} 个会话`);
          break;
        }

        case "session.create":
          const newSessionId = await this.bridge.createSession(params?.title, params?.task);
          result = { sessionId: newSessionId };
          this.log(`远程创建新会话: ${newSessionId}`);
          break;

        case "session.send_message":
          const ok = await this.bridge.sendMessage(params.sessionId, params.content);
          result = { success: ok };
          this.log(`向会话 ${params.sessionId} 派发远程指令`);
          break;

        case "session.interrupt":
          const cancelled = await this.bridge.cancelTask(params.sessionId);
          result = { success: cancelled };
          this.log(`远程中止会话 ${params.sessionId}`);
          break;

        case "fs.readDir":
          result = await this.bridge.readDir(params ?? {});
          this.log(`列出目录: ${result.path}（${result.entries.length} 项）`);
          break;

        case "ping":
          result = { pong: Date.now() };
          break;

        default:
          error = {
            code: -32601,
            message: `Method '${method}' is not implemented on Pi Desktop`
          };
          break;
      }
    } catch (e) {
      error = { code: -32000, message: e?.message || "Internal error" };
    }

    if (id !== undefined) {
      await this.sendResponse(id, result, error);
    }
  }

  async syncTimeline(sessionId, update) {
    await this.sendNotification("timeline.sync", {
      sessionId,
      timestamp: Date.now(),
      ...update
    });
  }
  async sendResponse(id, result, error) {
    if (!this.socketId) return;
    // 官方封装：{ id, type: "response", ok, result?, error? }
    const payload = JSON.stringify({
      id,
      type: "response",
      ok: !error,
      ...(error ? { error } : { result: result ?? {} })
    });
    await pi.net.websocket.send({ socketId: this.socketId, data: payload });
  }

  async sendNotification(method, params) {
    if (!this.socketId || !this.isConnected) return;
    // 官方封装：{ type: "notification", method, params }
    const payload = JSON.stringify({ type: "notification", method, params: params ?? {} });
    await pi.net.websocket.send({ socketId: this.socketId, data: payload });
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    // 官方方法名为 connector.heartbeat（见 connector/runtime.py _heartbeat_loop）
    this.heartbeatTimer = setInterval(() => {
      this.sendNotification("connector.heartbeat", { clientTime: Date.now() }).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  async disconnect() {
    this.cleanup();
    if (this.socketId) {
      try {
        await pi.net.websocket.close({ socketId: this.socketId });
      } catch {}
      this.socketId = null;
    }
    this.log("已断开远程连接");
  }

  cleanup() {
    this.isConnected = false;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.tokenRefreshTimer);
    this.reconnectTimer = null;
    this.tokenRefreshTimer = null;
    if (this._onMessage) pi.events.off("net:websocket:message", this._onMessage);
    if (this._onClose) pi.events.off("net:websocket:close", this._onClose);
    if (this._onError) pi.events.off("net:websocket:error", this._onError);
  }
}

// 3. 插件生命周期绑定
const bridge = new DesktopBridge();
let client = null;
let activated = false;

async function activate() {
  console.log("[pi.agents-anywhere] Plugin starting up...");

  // 从 storage 读取用户配置
  // 兼容宿主版本差异：部分版本的插件宿主不提供 pi.storage.*，旧实现直接
  // `await pi.storage.get(...)` 会抛 TypeError，导致 activate() 中途失败、
  // bus 订阅未注册，面板点击「一键识别并建立连接」表现为毫无反应。
  // 这里统一改为优先使用 pi.plugin.getSettings()/setSettings()，
  // 并回退到 pi.plugin.getDataPath() 目录下的本地 JSON 文件。
  const storedConfig = await readStoredConfig();

  // 幂等：宿主在模块加载后会调用导出的 onLoad()，而模块底部不再自执行，
  // 避免 activate() 被触发两次。两次激活会让两个 AnywhereClient 争抢同一个
  // connector：一个连上占住槽位，另一个持续收到服务端 4409（HTTP 403）。
  if (activated) {
    console.warn("[pi.agents-anywhere] activate() 已执行过，跳过重复初始化");
    return;
  }
  activated = true;
  bridge.config = storedConfig;
  client = new AnywhereClient(storedConfig, bridge);
  client.log("Agents Anywhere 插件就绪");

  // 自动连接
  if (storedConfig.connectorId && storedConfig.connectorToken) {
    client.connect();
  }

  // 监听桌面端轮次结束事件
  pi.events.on("session:turnEnded", async (event) => {
    if (client && client.isConnected) {
      await client.syncTimeline(event.sessionId, {
        phase: "turn_ended",
        reason: event.reason
      });
    }
  });

  // 监听桌面端工作区切换
  pi.events.on("workspace:changed", async (workspace) => {
    if (client && client.isConnected) {
      await client.syncTimeline("global", {
        type: "workspace_changed",
        workspace: workspace ? { path: workspace.path, name: workspace.name } : null
      });
    }
  });

  // 面板通信：宿主 webview preload 只暴露 window.pluginBridge.invoke(channel, payload)，
  // 并由宿主路由到下方导出的 onPanelInvoke。这里同时保留 pi.bus 订阅，
  // 以便将来宿主支持 bus 面板通道时也能工作。
  if (typeof pi.bus?.subscribe === "function") {
    pi.bus.subscribe("anywhere:get_status", async () => {
      return client ? client.getStatus() : { connected: false, logs: [] };
    });
    pi.bus.subscribe("anywhere:save_config", (newConfig) => saveAndConnect(newConfig ?? {}));
  }

  // 面板（webview）经由宿主 preload 暴露的 window.pluginBridge.invoke(channel, payload)
  // 调用，宿主会把请求路由到本导出函数。旧实现依赖 window.pi.bus（宿主并不提供），
  // 因此面板的任何操作都无法送达插件进程。
  module.exports.onPanelInvoke = async (channel, payload) => {
    switch (channel) {
      case "anywhere:get_status":
        return client ? client.getStatus() : { connected: false, logs: [] };
      case "anywhere:save_config":
      case "anywhere:save_config":
        return await saveAndConnect(payload ?? {});
      case "anywhere:pick_root": {
        // 桌面端点一次「选择目录」，授权插件可读取的根目录（可为主目录 ~）
        // requestRoot 定义在 DesktopBridge 上（bridge），不在 AnywhereClient 上
        try {
          const picked = await bridge.requestRoot();
          return picked;
        } catch (err) {
          return { ok: false, message: err?.message || String(err) };
        }
      }
        return { ok: false, code: "UNSUPPORTED", message: `unknown channel: ${channel}` };
    }
  };
}

async function saveAndConnect(newConfig) {
  await writeStoredConfig(newConfig);
  if (client) await client.disconnect();
  client = new AnywhereClient(newConfig, bridge);
  await client.connect();
  return { success: true };
}

/**
 * 读取持久化配置。优先 pi.plugin.getSettings()；
 * 若宿主不提供或调用失败，回退到 pi.plugin.getDataPath() 下的 connector_config.json；
 * 两者都不可用时返回默认配置（而不是抛错），保证插件始终能完成激活。
 */
async function readStoredConfig() {
  const fallback = {
    serverUrl: "https://api.agents-anywhere.com",
    connectorId: "",
    connectorToken: "",
    deviceName: "My-Pi-Desktop"
  };

  try {
    if (typeof pi.plugin?.getSettings === "function") {
      const settings = await pi.plugin.getSettings();
      const cfg = settings?.anywhereConfig;
      if (cfg && typeof cfg === "object") return { ...fallback, ...cfg };
    }
  } catch (e) {
    console.warn("[pi.agents-anywhere] getSettings 不可用，回退本地文件:", e?.message || e);
  }

  try {
    const file = await configFilePath();
    if (file && fsSync.existsSync(file)) {
      const cfg = JSON.parse(fsSync.readFileSync(file, "utf8"));
      if (cfg && typeof cfg === "object") return { ...fallback, ...cfg };
    }
  } catch (e) {
    console.warn("[pi.agents-anywhere] 读取本地配置失败:", e?.message || e);
  }

  return fallback;
}

async function writeStoredConfig(config) {
  let written = false;
  try {
    if (typeof pi.plugin?.setSettings === "function") {
      const current = (typeof pi.plugin.getSettings === "function"
        ? await pi.plugin.getSettings()
        : {}) || {};
      await pi.plugin.setSettings({ ...current, anywhereConfig: config });
      written = true;
    }
  } catch (e) {
    console.warn("[pi.agents-anywhere] setSettings 不可用，回退本地文件:", e?.message || e);
  }

  try {
    const file = await configFilePath();
    if (file) {
      fsSync.mkdirSync(path.dirname(file), { recursive: true });
      fsSync.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
      written = true;
    }
  } catch (e) {
    console.warn("[pi.agents-anywhere] 写入本地配置失败:", e?.message || e);
  }

  if (!written) {
    console.warn("[pi.agents-anywhere] 配置未能持久化，本次连接仅在当前进程有效");
  }
}

async function configFilePath() {
  try {
    if (typeof pi.plugin?.getDataPath === "function") {
      const dataPath = await pi.plugin.getDataPath();
      if (dataPath) return path.join(dataPath, "connector_config.json");
    }
  } catch {
    /* 忽略，返回 null */
  }
  return null;
}

// 导出面板调用入口：宿主通过 pluginBridge.invoke 路由到这里
// 注意：宿主在加载模块后会自行调用 onLoad()，因此这里不再自执行 activate()，
// 否则会激活两次并导致两个客户端争抢同一个 connector。
module.exports.onLoad = activate;
module.exports.onUnload = async () => {
  if (client) await client.disconnect();
};

// 兜底：若宿主未调用 onLoad（旧版宿主），模块加载后自行激活一次。
// activated 守卫保证两种路径都只激活一次。
if (typeof process !== "undefined" && process.env.PI_AGENTS_ANYWHERE_NO_AUTOACTIVATE !== "1") {
  queueMicrotask(() => {
    activate().catch((err) => {
      console.error("[pi.agents-anywhere] Failed to activate:", err);
    });
  });
}

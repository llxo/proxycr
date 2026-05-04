const PATH = 'data/third/traffic-statistics'
const TAGS_FILE = PATH + '/tags.json'
const HIDDEN_RANKS_FILE = PATH + '/hidden-ranks.json'
const DataVersion = '-v1'
const SAVE_DEBOUNCE_MS = 10000

window[Plugin.id] = window[Plugin.id] || {
  state: {
    currentMonth: '',
    data: null,
    tagsConfig: {},
    hiddenRanks: [],
    lastConnections: {},
    saveTimer: null,
    unregs: []
  }
}

const store = window[Plugin.id].state

const getRootDomain = (host) => {
  if (!host) return host

  let hostname = host.split(':')[0].replace(/[\[\]]/g, '')
  hostname = hostname.replace(/\.$/, '')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || !hostname.includes('.')) {
    return hostname
  }

  const parts = hostname.split('.')
  if (parts.length <= 2) return hostname

  const secondToLast = parts[parts.length - 2].toLowerCase()
  const last = parts[parts.length - 1].toLowerCase()

  const commonSecondLevel = ['com', 'co', 'net', 'org', 'gov', 'edu', 'ac']
  if (last.length === 2 && commonSecondLevel.includes(secondToLast)) {
    return parts.slice(-3).join('.')
  }

  return parts.slice(-2).join('.')
}

const getProcessName = (metadata = {}) => {
  const process = metadata.processPath || metadata.process || metadata.processName || metadata.packageName || 'system'
  if (process === 'system') return process
  return String(process).split(/[\\/]/).filter(Boolean).pop() || String(process)
}

const isLocalClientIP = (ip) => {
  if (!ip) return false
  const value = String(ip).toLowerCase()
  return value === 'localhost' || value === '::1' || value.startsWith('127.') || value.startsWith('fdfe') || value.startsWith('172.18.')
}

const getClientIdentity = (metadata = {}, process = 'system') => {
  const sourceIP = metadata.sourceIP || 'unknown'
  if (isLocalClientIP(sourceIP) && process !== 'system') {
    return {
      id: process,
      type: 'process',
      sourceIP
    }
  }

  return {
    id: sourceIP,
    type: 'ip',
    sourceIP
  }
}

const createEmptyStats = () => ({
  summary: { up: 0, down: 0 },
  details: {
    domains: {},
    roots: {},
    nodes: {},
    processes: {},
    rules: {},
    tags: {},
    pivot_node_domain: {},
    pivot_tag_node: {},
    log_levels: {},
    dns_types: {},
    dns_domains: {},
    dns_ip_kinds: { 'fake-ip': 0, 'real-ip': 0 },
    clients: {}
  }
})

const mergeStats = (target, source) => {
  if (!source) return target
  target.summary.up += source.summary?.up || 0
  target.summary.down += source.summary?.down || 0

  // 按字段递归合并统计对象，用于清除单日数据后重建整月汇总。
  const mergeMap = (targetMap, sourceMap) => {
    Object.entries(sourceMap || {}).forEach(([key, value]) => {
      if (typeof value === 'number') {
        targetMap[key] = (targetMap[key] || 0) + value
        return
      }

      if (!targetMap[key]) targetMap[key] = Array.isArray(value) ? [] : {}
      Object.entries(value || {}).forEach(([subKey, subValue]) => {
        if (typeof subValue === 'number') {
          targetMap[key][subKey] = (targetMap[key][subKey] || 0) + subValue
        } else if (subValue && typeof subValue === 'object') {
          if (!targetMap[key][subKey]) targetMap[key][subKey] = {}
          mergeMap(targetMap[key][subKey], subValue)
        } else {
          targetMap[key][subKey] = targetMap[key][subKey] || subValue
        }
      })
    })
  }

  Object.entries(source.details || {}).forEach(([key, value]) => {
    if (!target.details[key]) target.details[key] = typeof value === 'number' ? 0 : {}
    if (typeof value === 'number') {
      target.details[key] += value
    } else {
      mergeMap(target.details[key], value)
    }
  })

  return target
}

const rebuildMonthlyDataFromDaily = (monthlyData) => {
  const daily = monthlyData?.daily || {}
  const next = { ...createEmptyStats(), daily }
  Object.values(daily).forEach((dayStats) => mergeStats(next, dayStats))
  return normalizeStats(next)
}

const normalizeStats = (stats) => {
  const applyShape = (target) => {
    const base = createEmptyStats()
    target.summary = { ...base.summary, ...(target.summary || {}) }
    target.details = { ...base.details, ...(target.details || {}) }
    return target
  }

  stats = applyShape(stats || {})
  stats.daily = stats.daily || {}

  // 兼容旧版本数据文件，避免新增维度读取时出现 undefined。
  Object.values(stats.daily).forEach((dayStats) => {
    applyShape(dayStats)
  })

  return stats
}

const initMonthlyData = async () => {
  const month = Plugins.formatDate(Date.now(), 'YYYY-MM')
  const content = await Plugins.ReadFile(`${PATH}/${month}${DataVersion}.json`).catch(() => JSON.stringify({ ...createEmptyStats(), daily: {} }))
  store.data = normalizeStats(JSON.parse(content))
  store.currentMonth = month
}

const initTagsConfig = async () => {
  const content = await Plugins.ReadFile(TAGS_FILE).catch(() => '{}')
  store.tagsConfig = JSON.parse(content || '{}')
}

const initHiddenRanks = async () => {
  const content = await Plugins.ReadFile(HIDDEN_RANKS_FILE).catch(() => '{}')
  const parsed = JSON.parse(content || '[]')
  store.hiddenRanks = Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
}

const saveTagsConfig = async () => {
  await Plugins.MakeDir(PATH).catch(() => {})
  await Plugins.WriteFile(TAGS_FILE, JSON.stringify(store.tagsConfig, null, 2))
}

const saveHiddenRanks = async () => {
  await Plugins.MakeDir(PATH).catch(() => {})
  await Plugins.WriteFile(HIDDEN_RANKS_FILE, JSON.stringify(store.hiddenRanks, null, 2))
}

const saveMonthlyData = async () => {
  if (!store.currentMonth || !store.data) return
  await Plugins.MakeDir(PATH).catch(() => {})
  const path = `${PATH}/${store.currentMonth}${DataVersion}.json`
  await Plugins.WriteFile(path, JSON.stringify(store.data))
}

const scheduleSaveMonthlyData = () => {
  if (store.saveTimer) return
  // 统计事件频率较高，延迟合并写盘，避免每条连接或日志都触发文件写入。
  store.saveTimer = setTimeout(async () => {
    store.saveTimer = null
    await saveMonthlyData().catch((err) => {
      console.log(`[${Plugin.name}] saveMonthlyData`, err)
    })
  }, SAVE_DEBOUNCE_MS)
}

const flushMonthlyData = async () => {
  if (store.saveTimer) {
    clearTimeout(store.saveTimer)
    store.saveTimer = null
  }
  await saveMonthlyData()
}

const updateStats = (target, diffUp, diffDown, isNew, info) => {
  if (!target) return
  const { node, fqdn, root, process, rule, tags, clientIP, clientType, sourceIP } = info
  const safeTags = Array.isArray(tags) ? tags : []
  target.summary.up += diffUp
  target.summary.down += diffDown

  const d = target.details
  const maps = [
    [d.domains, fqdn, true],
    [d.roots, root, true],
    [d.nodes, node, false],
    [d.processes, process, false],
    [d.rules, rule, true]
  ]

  maps.forEach(([map, key, hasHits]) => {
    if (!map[key]) map[key] = { up: 0, down: 0, ...(hasHits ? { hits: 0 } : {}) }
    map[key].up += diffUp
    map[key].down += diffDown
    if (isNew && hasHits) map[key].hits++
  })

  // 客户端统计
  if (clientIP) {
    if (!d.clients[clientIP]) {
      d.clients[clientIP] = {
        up: 0,
        down: 0,
        hits: 0,
        domains: {},
        nodes: {},
        processes: {},
        rules: {},
        tags: {},
        type: clientType || 'ip',
        sourceIP: sourceIP || clientIP
      }
    }
    const c = d.clients[clientIP]
    c.type = c.type || clientType || 'ip'
    c.sourceIP = c.sourceIP || sourceIP || clientIP
    c.up += diffUp
    c.down += diffDown
    if (isNew) c.hits++

    // 定义需要同步在客户端下统计的子维度
    const subDimensions = [
      [c.domains, fqdn],
      [c.nodes, node],
      [c.processes, process],
      [c.rules, rule]
    ]

    subDimensions.forEach(([map, key]) => {
      if (!map[key]) map[key] = { up: 0, down: 0, hits: 0 }
      map[key].up += diffUp
      map[key].down += diffDown
      if (isNew) map[key].hits++
    })

    // 统计客户端下的标签分布
    safeTags.forEach((tag) => {
      if (!c.tags[tag]) c.tags[tag] = { up: 0, down: 0, hits: 0 }
      c.tags[tag].up += diffUp
      c.tags[tag].down += diffDown
      if (isNew) c.tags[tag].hits++
    })
  }

  safeTags.forEach((tag) => {
    if (!d.tags[tag]) d.tags[tag] = { up: 0, down: 0 }
    d.tags[tag].up += diffUp
    d.tags[tag].down += diffDown
    if (!d.pivot_tag_node[tag]) d.pivot_tag_node[tag] = {}
    if (!d.pivot_tag_node[tag][node]) d.pivot_tag_node[tag][node] = { up: 0, down: 0 }
    d.pivot_tag_node[tag][node].up += diffUp
    d.pivot_tag_node[tag][node].down += diffDown
  })

  if (!d.pivot_node_domain[node]) d.pivot_node_domain[node] = {}
  if (!d.pivot_node_domain[node][fqdn]) d.pivot_node_domain[node][fqdn] = { up: 0, down: 0 }
  d.pivot_node_domain[node][fqdn].up += diffUp
  d.pivot_node_domain[node][fqdn].down += diffDown
}

const handleConnections = async (data) => {
  const connections = data.connections || []
  const now = new Date()
  const month = Plugins.formatDate(now.getTime(), 'YYYY-MM')

  // 跨月检查
  if (month !== store.currentMonth) {
    await flushMonthlyData()
    await initMonthlyData()
  }

  const day = now.getDate().toString()
  const currentIDs = new Set()
  let changed = false

  if (!store.data.daily[day]) store.data.daily[day] = createEmptyStats()
  const dayData = store.data.daily[day]

  for (const conn of connections) {
    const { id, download = 0, upload = 0, chains = [], metadata = {}, rule } = conn
    currentIDs.add(id)
    const previousRecord = store.lastConnections[id]
    const prev = previousRecord || { download: 0, upload: 0 }
    const diffDown = download - prev.download
    const diffUp = upload - prev.upload

    if (diffDown > 0 || diffUp > 0) {
      const process = getProcessName(metadata)
      const client = getClientIdentity(metadata, process)
      const destination = metadata.host || metadata.destinationIP || 'unknown'

      const info = {
        node: chains[0] || 'DIRECT',
        fqdn: destination,
        root: getRootDomain(destination),
        process,
        rule: rule || 'Match',
        tags: store.tagsConfig[getRootDomain(destination)] || store.tagsConfig[metadata.host] || [],
        clientIP: client.id,
        clientType: client.type,
        sourceIP: client.sourceIP
      }
      const isNew = !previousRecord
      updateStats(store.data, diffUp, diffDown, isNew, info)
      updateStats(dayData, diffUp, diffDown, isNew, info)
      changed = true
    }
    store.lastConnections[id] = { download, upload }
  }
  for (const id in store.lastConnections) {
    if (!currentIDs.has(id)) delete store.lastConnections[id]
  }
  if (changed) scheduleSaveMonthlyData()
}

const handleLogs = async (data) => {
  if (!store.data) return
  const now = new Date()
  const day = now.getDate().toString()
  if (!store.data.daily[day]) store.data.daily[day] = createEmptyStats()
  const dayData = store.data.daily[day]

  // 统计日志级别
  const type = data.type || 'unknown'
  const updateLogType = (target) => {
    if (!target.details.log_levels) target.details.log_levels = {}
    target.details.log_levels[type] = (target.details.log_levels[type] || 0) + 1
  }
  updateLogType(store.data)
  updateLogType(dayData)

  // DNS 解析逻辑
  let dnsInfo = null

  // clash匹配逻辑：
  // 1. 必须包含 [DNS]
  // 2. 必须包含 --> (这代表它是结果返回，排除了 resolve 和 hijack 日志)
  // 3. 兼容 "cache hit" 字样
  // 正则解析：分组1=域名，分组2=结果列表，分组3=记录类型
  const dnsMatch = data.payload.match(/\[DNS\](?:\s+cache\s+hit)?\s+([^\s]+)\s+-->\s+\[(.*?)\]\s+([A-Z0-9]+)/i)

  if (dnsMatch) {
    const domain = dnsMatch[1].replace(/\.$/, '')
    const results = dnsMatch[2].trim().split(/\s+/) // 获取 IP 列表
    const dnsType = dnsMatch[3].toUpperCase()

    dnsInfo = {
      domain,
      dnsType,
      // 取第一个结果用于判定 Fake-IP，如果没有结果则传空字符串
      result: results[0] || ''
    }
  }
  // singbox匹配逻辑
  else if (data.payload.includes('dns: exchanged')) {
    const legacyMatch = data.payload.match(/dns: exchanged\s+([A-Z0-9]+)\s+([^\s]+)\s+\d+\s+IN\s+[A-Z0-9]+\s+([^\s]+)/i)
    if (legacyMatch) {
      dnsInfo = {
        dnsType: legacyMatch[1].toUpperCase(),
        domain: legacyMatch[2].replace(/\.$/, ''),
        result: legacyMatch[3]
      }
    }
  }

  // 统一更新统计数据
  if (dnsInfo) {
    const { dnsType, domain, result } = dnsInfo

    const updateDnsStats = (target) => {
      const d = target.details
      // 初始化字段
      if (!d.dns_types) d.dns_types = {}
      if (!d.dns_domains) d.dns_domains = {}
      if (!d.dns_ip_kinds) d.dns_ip_kinds = { 'fake-ip': 0, 'real-ip': 0 }

      // 统计解析类型 (A, AAAA)
      d.dns_types[dnsType] = (d.dns_types[dnsType] || 0) + 1

      // 统计域名命中次数
      if (!d.dns_domains[domain]) d.dns_domains[domain] = { hits: 0, types: {} }
      d.dns_domains[domain].hits++
      d.dns_domains[domain].types[dnsType] = (d.dns_domains[domain].types[dnsType] || 0) + 1

      // Fake-IP 判定逻辑
      if ((dnsType === 'A' || dnsType === 'AAAA') && result) {
        // IPv4 Fake-IP: 198.18.x.x
        // IPv6 Fake-IP: 通常以 fc00 或 fd00 开头 (用户可根据具体配置调整)
        const isFake = result.startsWith('198.18.') || result.toLowerCase().startsWith('fc00') || result.toLowerCase().startsWith('fd00')

        const kind = isFake ? 'fake-ip' : 'real-ip'
        d.dns_ip_kinds[kind] = (d.dns_ip_kinds[kind] || 0) + 1
      }
    }

    updateDnsStats(store.data)
    updateDnsStats(dayData)
  }

  scheduleSaveMonthlyData()
}

const Start = async (params = Plugin) => {
  console.log(`[${Plugin.name}] Start()`)
  const router = new Router()
  registerStatsApi(router)
  registerTagsApi(router)
  router.get('/v1/docs/json', {}, (req, res) =>
    res.json(
      200,
      router.routes.map((r) => ({ method: r.method, path: r.path, metadata: r.metadata }))
    )
  )
  await Plugins.StartServer(params.ApiAddress, Plugin.id, async (req, res) => router.match(req, res))
  registerHandler()
  return 1
}

const Stop = async () => {
  console.log(`[${Plugin.name}] Stop()`)
  await flushMonthlyData()
  await Plugins.StopServer(Plugin.id)
  unRegisterHandler()
  return 2
}

const registerHandler = () => {
  const kernel = Plugins.useKernelApiStore()
  store.unregs.push(kernel.onConnections(handleConnections))
  store.unregs.push(kernel.onLogs(handleLogs))
  store.unregs.push(kernel.onTraffic((data) => {}))
  store.unregs.push(kernel.onMemory((data) => {}))
}

const unRegisterHandler = () => {
  store.unregs.forEach((u) => u?.())
  store.unregs = []
}

const onBeforeCoreStart = async (config, profile) => {
  // 改成debug以便收集更多信息
  if (Plugins.APP_TITLE.includes('SingBox')) {
    config.log.level = 'debug'
  }
  return config
}

const onReady = async () => {
  await initMonthlyData()
  await initTagsConfig()
  await initHiddenRanks()
  await Stop().catch((err) => {
    console.log(`[${Plugin.name}] onReady: Stop()`, err)
  })
  await Start().catch((err) => {
    console.log(`[${Plugin.name}] onReady: Start()`, err)
  })
  return 1
}

const onShutdown = async () => {
  await Stop().catch((err) => {
    console.log(`[${Plugin.name}] onShutdown: Stop()`, err)
  })
  return 2
}

const onReload = async () => {
  await flushMonthlyData()
}

const onRun = async () => {
  if (!store.data) await initMonthlyData()
  await initTagsConfig()
  await initHiddenRanks()
  home().open()
  return 0
}

const home = () => {
  const { ref, computed } = Vue
  const dimensions = [
    { label: '域名', value: 'domains', sort: 'down' },
    { label: '根域名', value: 'roots', sort: 'down' },
    { label: '节点', value: 'nodes', sort: 'down' },
    { label: '进程', value: 'processes', sort: 'down' },
    { label: '规则', value: 'rules', sort: 'hits' },
    { label: '标签', value: 'tags', sort: 'down' },
    { label: '客户端/进程', value: 'clients', sort: 'down' },
    { label: 'DNS域名', value: 'dns_domains', sort: 'hits' },
    { label: 'DNS类型', value: 'dns_types', sort: 'count' },
    { label: 'FakeIP', value: 'dns_ip_kinds', sort: 'count' },
    { label: '日志', value: 'log_levels', sort: 'count' }
  ]

  const component = {
    template: `
    <div style="padding: 0 8px 12px 0; color: #202124;">
      <div style="display:flex; justify-content:space-between; gap:16px; align-items:flex-start; padding: 12px 0 18px;">
        <div>
          <div style="font-size:22px; font-weight:700; letter-spacing:0;">流量统计</div>
          <div style="margin-top:6px; color:#5f6368; font-size:12px;">{{ month }} <span v-if="day !== 'all'">/ {{ day }} 日</span></div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <select v-model="month" @change="loadMonth" style="height:32px; min-width:120px; border:1px solid #dadce0; border-radius:6px; padding:0 8px; background:#fff;">
            <option v-for="m in months" :key="m" :value="m">{{ m }}</option>
          </select>
          <select v-model="day" style="height:32px; min-width:92px; border:1px solid #dadce0; border-radius:6px; padding:0 8px; background:#fff;">
            <option value="all">整月</option>
            <option v-for="d in days" :key="d" :value="d">{{ d }} 日</option>
          </select>
          <Button @click="refresh" type="primary">刷新</Button>
          <Button @click="clearData" type="text">清除数据</Button>
        </div>
      </div>

      <div style="display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:10px; margin-bottom:14px;">
        <div v-for="card in summaryCards" :key="card.label" style="border:1px solid #e0e3e7; border-radius:8px; padding:12px; background:#fff;">
          <div style="font-size:12px; color:#6b7280;">{{ card.label }}</div>
          <div style="margin-top:8px; font-size:20px; font-weight:700;">{{ card.value }}</div>
        </div>
      </div>

      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
        <button
          v-for="item in visibleDimensions"
          :key="item.value"
          @click="selectDimension(item)"
          :style="tabStyle(item.value)"
        >{{ item.label }}</button>
      </div>

      <div style="display:grid; grid-template-columns: minmax(0, 1fr) 320px; gap:14px; align-items:start;">
        <section style="border:1px solid #e0e3e7; border-radius:8px; background:#fff; overflow:hidden;">
          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; border-bottom:1px solid #edf0f2;">
            <div style="font-weight:700;">{{ currentDimensionLabel }}排行</div>
            <div style="display:flex; gap:8px; align-items:center;">
              <input v-model="keyword" placeholder="过滤名称" style="height:30px; width:160px; border:1px solid #dadce0; border-radius:6px; padding:0 8px;" />
              <select v-model="sort" style="height:30px; border:1px solid #dadce0; border-radius:6px; padding:0 8px; background:#fff;">
                <option value="down">下行</option>
                <option value="up">上行</option>
                <option value="hits">命中</option>
                <option value="count">数量</option>
              </select>
            </div>
          </div>

          <table style="width:100%; border-collapse:collapse; table-layout:fixed;">
            <thead>
              <tr style="background:#f8fafb; color:#5f6368; font-size:12px;">
                <th style="text-align:left; padding:9px 12px;">名称</th>
                <th style="width:92px; text-align:right; padding:9px 8px;">下行</th>
                <th style="width:92px; text-align:right; padding:9px 8px;">上行</th>
                <th style="width:74px; text-align:right; padding:9px 12px;">命中</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.name" style="border-top:1px solid #edf0f2;">
                <td style="padding:10px 12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" :title="row.name">{{ row.name }}</td>
                <td style="padding:10px 8px; text-align:right; font-variant-numeric:tabular-nums;">{{ formatBytes(row.down) }}</td>
                <td style="padding:10px 8px; text-align:right; font-variant-numeric:tabular-nums;">{{ formatBytes(row.up) }}</td>
                <td style="padding:10px 12px; text-align:right; font-variant-numeric:tabular-nums;">{{ displayCount(row) }}</td>
              </tr>
              <tr v-if="rows.length === 0">
                <td colspan="4" style="padding:28px 12px; text-align:center; color:#87909a;">暂无数据</td>
              </tr>
            </tbody>
          </table>
        </section>

        <aside style="display:flex; flex-direction:column; gap:14px;">
          <section style="border:1px solid #e0e3e7; border-radius:8px; background:#fff; padding:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px;">
              <div>
                <div style="font-weight:700;">隐藏管理</div>
                <div style="margin-top:4px; color:#6b7280; font-size:12px;">已隐藏 {{ hiddenRankingCount }} 个排行榜</div>
              </div>
              <Button v-if="hiddenRankingCount" @click="clearHiddenRanks" type="link" size="small">全部显示</Button>
            </div>
            <div style="margin-bottom:8px; color:#6b7280; font-size:12px; line-height:1.45;">
              勾选后隐藏对应排行榜入口，不记录域名、节点等具体排行项。
            </div>
            <div style="display:flex; flex-direction:column; gap:6px; max-height:132px; overflow:auto;">
              <div
                v-for="item in dimensions"
                :key="item.value"
                style="display:flex; align-items:center; justify-content:space-between; gap:8px; border:1px solid #edf0f2; border-radius:6px; padding:6px 8px;"
              >
                <label style="display:flex; align-items:center; gap:8px; min-width:0; color:#3c4043; font-size:12px; cursor:pointer;">
                  <input
                    type="checkbox"
                    :checked="isRankingHidden(item.value)"
                    @change="toggleHiddenRank(item, $event.target.checked)"
                    style="margin:0;"
                  />
                  <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{{ item.label }}排行</span>
                </label>
                <span style="color:#87909a; font-size:12px;">{{ isRankingHidden(item.value) ? '隐藏' : '显示' }}</span>
              </div>
            </div>
          </section>

          <section style="border:1px solid #e0e3e7; border-radius:8px; background:#fff; padding:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <div style="font-weight:700;">标签配置</div>
              <Button @click="saveTags" type="link" size="small">保存</Button>
            </div>
            <div style="margin-bottom:8px; color:#6b7280; font-size:12px; line-height:1.45;">
              根域名或完整域名映射到标签数组，用于汇总“标签”排行。
            </div>
            <textarea
              v-model="tagsText"
              spellcheck="false"
              style="width:100%; min-height:120px; resize:vertical; border:1px solid #dadce0; border-radius:6px; padding:8px; font-family:Consolas, monospace; font-size:12px; line-height:1.5;"
            ></textarea>
          </section>
        </aside>
      </div>
    </div>
    `,
    setup() {
      const month = ref(store.currentMonth)
      const day = ref('all')
      const months = ref([store.currentMonth].filter(Boolean))
      const data = ref(store.data)

      // 隐藏管理只保存排行榜维度，不保存具体域名、节点、进程等排行项。
      const normalizeHiddenRanks = (list) => {
        const validValues = new Set(dimensions.map((item) => item.value))
        const uniqueValues = Array.from(new Set(Array.isArray(list) ? list : [])).filter((value) => validValues.has(value))
        return uniqueValues.length >= dimensions.length ? uniqueValues.slice(0, dimensions.length - 1) : uniqueValues
      }

      const hiddenRanks = ref(normalizeHiddenRanks(store.hiddenRanks))
      const defaultDimension = dimensions.find((item) => !hiddenRanks.value.includes(item.value)) || dimensions[0]
      const dimension = ref(defaultDimension.value)
      const sort = ref(defaultDimension.sort)
      const keyword = ref('')
      const tagsText = ref(JSON.stringify(store.tagsConfig || {}, null, 2))

      const formatBytes = (bytes = 0) => {
        const value = Number(bytes || 0)
        if (value < 1024) return `${value} B`
        const units = ['KB', 'MB', 'GB', 'TB']
        let size = value / 1024
        let index = 0
        while (size >= 1024 && index < units.length - 1) {
          size /= 1024
          index++
        }
        return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`
      }

      const displayCount = (row) => {
        if (row.hits != null) return row.hits
        if (row.count != null) return row.count
        return '-'
      }

      const normalizeMonthName = (name) => name.replace(/\.json$/, '').replace(DataVersion, '')

      const loadMonths = async () => {
        const files = await Plugins.ReadDir(PATH).catch(() => [])
        const fileMonths = files.filter((f) => f.name.endsWith(`${DataVersion}.json`)).map((f) => normalizeMonthName(f.name))
        months.value = Array.from(new Set([store.currentMonth, ...fileMonths].filter(Boolean))).sort().reverse()
      }

      const loadMonth = async () => {
        day.value = 'all'
        if (!month.value || month.value === store.currentMonth) {
          data.value = store.data
          return
        }
        const content = await Plugins.ReadFile(`${PATH}/${month.value}${DataVersion}.json`).catch(() => null)
        try {
          data.value = content ? normalizeStats(JSON.parse(content)) : null
        } catch (error) {
          data.value = null
          Plugins.message.error(`历史统计文件解析失败: ${error.message || error}`)
        }
      }

      const refresh = async () => {
        if (month.value === store.currentMonth) data.value = store.data
        await loadMonths()
        await loadMonth()
      }

      const target = computed(() => {
        if (!data.value) return null
        return day.value === 'all' ? data.value : data.value.daily?.[day.value]
      })

      const days = computed(() => Object.keys(data.value?.daily || {}).sort((a, b) => Number(a) - Number(b)))

      const summaryCards = computed(() => {
        const t = target.value
        const details = t?.details || {}
        return [
          { label: '下行流量', value: formatBytes(t?.summary?.down) },
          { label: '上行流量', value: formatBytes(t?.summary?.up) },
          { label: '域名数', value: Object.keys(details.domains || {}).length },
          { label: '客户端/进程数', value: Object.keys(details.clients || {}).length }
        ]
      })

      const hiddenRankSet = computed(() => new Set(hiddenRanks.value))

      const visibleDimensions = computed(() => dimensions.filter((item) => !hiddenRankSet.value.has(item.value)))

      const hiddenRankingCount = computed(() => hiddenRanks.value.length)

      const isRankingHidden = (value) => hiddenRankSet.value.has(value)

      const rows = computed(() => {
        const map = target.value?.details?.[dimension.value] || {}
        const list = Object.entries(map).map(([name, val]) => {
          if (typeof val === 'number') return { name, count: val, up: 0, down: 0 }
          return { name, ...val, up: val.up || 0, down: val.down || 0, hits: val.hits, count: val.count, raw: val }
        })
        const word = keyword.value.trim().toLowerCase()
        const filtered = word ? list.filter((item) => item.name.toLowerCase().includes(word)) : list
        return filtered.sort((a, b) => Number(b[sort.value] || 0) - Number(a[sort.value] || 0)).slice(0, 100)
      })

      const currentDimensionLabel = computed(() => dimensions.find((item) => item.value === dimension.value)?.label || dimension.value)

      const selectDimension = (item) => {
        dimension.value = item.value
        sort.value = item.sort
      }

      const tabStyle = (value) => ({
        height: '30px',
        border: value === dimension.value ? '1px solid #185abc' : '1px solid #dadce0',
        borderRadius: '6px',
        padding: '0 10px',
        background: value === dimension.value ? '#e8f0fe' : '#fff',
        color: value === dimension.value ? '#174ea6' : '#3c4043',
        cursor: 'pointer',
        fontSize: '12px'
      })

      const saveTags = async () => {
        try {
          const next = JSON.parse(tagsText.value || '{}')
          store.tagsConfig = next
          await saveTagsConfig()
          Plugins.message.info('标签配置已保存')
        } catch (error) {
          Plugins.message.error(`标签 JSON 格式错误: ${error.message || error}`)
        }
      }

      const updateHiddenRanks = async (next) => {
        hiddenRanks.value = next
        store.hiddenRanks = next
        await saveHiddenRanks()
      }

      const toggleHiddenRank = async (item, checked) => {
        const current = normalizeHiddenRanks(hiddenRanks.value)
        if (checked && !current.includes(item.value) && current.length >= dimensions.length - 1) {
          Plugins.message.error('至少保留一个排行榜')
          return
        }

        const next = checked
          ? Array.from(new Set([...current, item.value]))
          : current.filter((value) => value !== item.value)
        await updateHiddenRanks(next)

        if (checked && dimension.value === item.value) {
          const nextDimension = dimensions.find((dimensionItem) => !next.includes(dimensionItem.value))
          if (nextDimension) selectDimension(nextDimension)
        }
      }

      const clearHiddenRanks = async () => {
        if (!hiddenRanks.value.length) return
        await updateHiddenRanks([])
        Plugins.message.info('所有排行榜已显示')
      }

      const saveViewedMonthData = async () => {
        if (month.value === store.currentMonth) {
          store.data = data.value
          await saveMonthlyData()
          return
        }
        await Plugins.MakeDir(PATH).catch(() => {})
        await Plugins.WriteFile(`${PATH}/${month.value}${DataVersion}.json`, JSON.stringify(data.value))
      }

      const clearData = async () => {
        if (!month.value || !data.value) return

        const scope = day.value === 'all' ? `${month.value} 整月` : `${month.value}-${String(day.value).padStart(2, '0')}`
        if (day.value === 'all') {
          data.value = normalizeStats({ ...createEmptyStats(), daily: {} })
        } else {
          data.value.daily = data.value.daily || {}
          delete data.value.daily[day.value]
          data.value = rebuildMonthlyDataFromDaily(data.value)
        }

        await saveViewedMonthData()
        await refresh()
        Plugins.message.info(`已清除 ${scope} 的统计数据`)
      }

      loadMonths()

      return {
        month,
        day,
        months,
        days,
        dimensions,
        dimension,
        visibleDimensions,
        sort,
        keyword,
        tagsText,
        summaryCards,
        rows,
        hiddenRankingCount,
        isRankingHidden,
        currentDimensionLabel,
        formatBytes,
        displayCount,
        loadMonth,
        refresh,
        selectDimension,
        tabStyle,
        saveTags,
        toggleHiddenRank,
        clearHiddenRanks,
        clearData
      }
    }
  }

  const modal = Plugins.modal(
    {
      title: '流量统计',
      submit: false,
      width: '92',
      cancelText: '关闭',
      afterClose: () => {
        modal.destroy()
      }
    },
    {
      default: () => Vue.h(component)
    }
  )

  return modal
}

const Utils = {
  paginate(data, pageNum, pageSize) {
    if (!Array.isArray(data)) {
      throw new Error('data must be an array')
    }

    pageNum = Math.max(1, Number(pageNum))
    pageSize = Math.max(1, Number(pageSize))

    const total = data.length
    const startIndex = (pageNum - 1) * pageSize
    const endIndex = startIndex + pageSize

    return {
      pageNum,
      pageSize,
      total,
      list: data.slice(startIndex, endIndex)
    }
  },
  sortByField(arr, field, order = 'desc') {
    return arr.sort((a, b) => {
      const valA = a[field]
      const valB = b[field]

      if (valA == null && valB == null) return 0
      if (valA == null) return 1
      if (valB == null) return -1

      if (typeof valA === 'number' && typeof valB === 'number') {
        return order === 'desc' ? valB - valA : valA - valB
      }

      return order === 'desc' ? String(valB).localeCompare(String(valA)) : String(valA).localeCompare(String(valB))
    })
  },
  paginateAndSort(list, query) {
    const { sort, pageNum = 1, pageSize = 10, order } = query
    sort && Utils.sortByField(list, sort, order)
    return Utils.paginate(list, pageNum, pageSize)
  },
  empty(query) {
    return {
      pageNum: Number(query.pageNum || 1),
      pageSize: Number(query.pageSize || 10),
      total: 0,
      list: []
    }
  },
  async getTargetData(query) {
    const { month, day } = query
    let targetMonthData = store.data
    if (month && month !== store.currentMonth) {
      try {
        targetMonthData = JSON.parse(await Plugins.ReadFile(`${PATH}/${month}${DataVersion}.json`))
      } catch (e) {
        return null
      }
    }
    const target = day ? targetMonthData.daily[day] : targetMonthData
    return target
  }
}

function registerStatsApi(router) {
  router.get(
    '/v1/stats/overview',
    {
      description: {
        zh: '实时统计概览'
      }
    },
    (req, res) => {
      res.json(200, {
        month_summary: store.data ? store.data.summary : null,
        current_month: store.currentMonth
      })
    }
  )

  router.get(
    '/v1/stats/rank/:dimension',
    {
      description: {
        zh: '按维度统计: domains,roots,nodes,processes,rules,tags,log_levels,dns_types,dns_domains,dns_ip_kinds,clients。系统代理本机流量会按进程名归类到 clients'
      },
      examples: {
        域名访问量排行: '/v1/stats/rank/domains?sort=hits',
        根域名访问量排行: '/v1/stats/rank/roots?sort=hits',
        节点下行流量排行: '/v1/stats/rank/nodes?sort=down',
        进程上行流量排行: '/v1/stats/rank/processes?sort=up',
        规则匹配次数排行: '/v1/stats/rank/rules?sort=hits',
        DNS解析域名排行: '/v1/stats/rank/dns_domains?sort=hits',
        日志级别分布: '/v1/stats/rank/log_levels',
        DNS类型统计: '/v1/stats/rank/dns_types',
        FakeIP和RealIP: '/v1/stats/rank/dns_ip_kinds',
        客户端或进程排行: '/v1/stats/rank/clients'
      }
    },
    async (req, res, { dimension }) => {
      const target = await Utils.getTargetData(req.query)
      if (!target || !target.details[dimension]) {
        return res.json(200, Utils.empty(req.query))
      }
      const list = Object.entries(target.details[dimension]).map(([name, val]) => {
        if (typeof val === 'number') return { name, count: val }
        return { name, ...val }
      })
      res.json(200, Utils.paginateAndSort(list, req.query))
    }
  )

  router.get(
    '/v1/stats/clients/:ip',
    {
      description: {
        zh: '按客户端或进程查询: ip/process'
      }
    },
    async (req, res, { ip }) => {
      const target = await Utils.getTargetData(req.query)
      if (!target || !target.details.clients[ip]) {
        return res.end(404, {}, `Client not found: ${ip}`)
      }
      res.json(200, target.details.clients[ip])
    }
  )

  router.get(
    '/v1/stats/clients/:ip/:dimension',
    {
      description: {
        zh: '按客户端或进程和维度查询: ip/process dimension'
      }
    },
    async (req, res, { ip, dimension }) => {
      const target = await Utils.getTargetData(req.query)
      if (!target || !target.details.clients[ip]?.[dimension]) {
        return res.json(200, Utils.empty(req.query))
      }
      const list = Object.entries(target.details.clients[ip][dimension]).map(([name, val]) => {
        if (typeof val === 'number') return { name, count: val }
        return { name, ...val }
      })
      res.json(200, Utils.paginateAndSort(list, req.query))
    }
  )

  router.get(
    '/v1/stats/pivot/:type/:key',
    {
      description: {
        zh: '按节点统计: node'
      }
    },
    async (req, res, { type, key }) => {
      const target = await Utils.getTargetData(req.query)
      if (!target) {
        return res.json(200, Utils.empty(req.query))
      }
      const pivotField = type === 'node' ? 'pivot_node_domain' : 'pivot_tag_node'
      const detailData = target.details[pivotField][key]
      if (!detailData) return res.json(404, 'No Data')
      const list = Object.entries(detailData).map(([name, val]) => ({ name, ...val }))
      res.json(200, Utils.paginateAndSort(list, req.query))
    }
  )

  router.get('/v1/stats/history/months', {}, async (req, res) => {
    try {
      const files = await Plugins.ReadDir(PATH)
      res.json(
        200,
        files.filter((f) => f.name.endsWith(`${DataVersion}.json`)).map((f) => f.name.replace(/\.json$/, '').replace(DataVersion, ''))
      )
    } catch (e) {
      res.json(200, [])
    }
  })
}

function registerTagsApi(router) {
  router.get('/v1/tags', {}, (req, res) => res.json(200, store.tagsConfig))
  router.post('/v1/tags', {}, async (req, res) => {
    store.tagsConfig = Plugins.deepAssign(store.tagsConfig, req.body)
    await saveTagsConfig()
    res.json(200, 'OK')
  })
}

class Router {
  constructor() {
    this.routes = []
    this.middlewares = []
  }

  use(middleware) {
    this.middlewares.push(middleware)
  }

  escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  register(method, path, metadata, handler) {
    const keys = []

    const [pathname] = path.split('?')

    const segments = pathname.split('/').map((segment) => {
      if (segment.startsWith(':')) {
        const key = segment.slice(1)
        keys.push(key)
        return '([^\\/]+)'
      }
      return this.escapeRegex(segment)
    })

    const regexPath = segments.join('/')
    const regex = new RegExp(`^${regexPath}$`)

    this.routes.push({
      method,
      regex,
      keys,
      metadata,
      handler,
      path: pathname
    })
  }

  get(path, metadata, handler) {
    this.register('GET', path, metadata, handler)
  }

  post(path, metadata, handler) {
    this.register('POST', path, metadata, handler)
  }

  put(path, metadata, handler) {
    this.register('PUT', path, metadata, handler)
  }

  delete(path, metadata, handler) {
    this.register('DELETE', path, metadata, handler)
  }

  async match(req, res) {
    res.json = (code, data) => res.end(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, JSON.stringify(data))

    for (const middleware of this.middlewares) {
      const next = await middleware(req, res)
      if (!next) return
    }

    const { method } = req
    const urlObj = new URL(req.url, 'http://localhost')
    const pathname = urlObj.pathname
    // @ts-ignore
    const query = Object.fromEntries(urlObj.searchParams)

    for (const route of this.routes) {
      if (route.method !== method) continue

      const match = pathname.match(route.regex)
      if (!match) continue

      const params = route.keys.reduce((acc, key, index) => {
        acc[key] = decodeURIComponent(match[index + 1])
        return acc
      }, {})

      req.params = params
      req.query = query

      try {
        await route.handler(req, res, params)
      } catch (error) {
        res.json(500, error.message || error)
      }
      return
    }

    res.json(404, 'Not Found')
  }
}

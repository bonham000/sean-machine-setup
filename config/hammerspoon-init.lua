-- Managed by sean-machine-setup. Run `task theme-switcher:setup` after editing.

-- Toggle between English (U.S.) and Traditional Chinese (Pinyin) with Ctrl+Space
hs.hotkey.bind({"ctrl"}, "space", function()
  local current = hs.keycodes.currentSourceID()

  local english = "com.apple.keylayout.US"
  local traditional = "com.apple.inputmethod.TCIM.Pinyin"

  if current == english then
    hs.keycodes.currentSourceID(traditional)
  else
    hs.keycodes.currentSourceID(english)
  end
end)

-- macOS Appearance switcher. Ghostty follows this setting through its paired
-- light and dark themes.
local function createTemplateIcon(elements)
  local iconCanvas = hs.canvas.new({ x = 0, y = 0, w = 16, h = 16 })
  for index, element in ipairs(elements) do
    iconCanvas[index] = element
  end

  local icon = iconCanvas:imageFromCanvas()
  iconCanvas:delete()

  if icon then
    icon:size({ w = 14, h = 14 }, true):template(true)
  end

  return icon
end

local iconColor = { white = 0 }
local sunElements = {
  {
    type = "circle",
    action = "stroke",
    center = { x = 8, y = 8 },
    radius = 3.1,
    strokeColor = iconColor,
    strokeWidth = 1.45,
  },
}

local sunRays = {
  { 8, 0.8, 8, 2.6 },
  { 8, 13.4, 8, 15.2 },
  { 0.8, 8, 2.6, 8 },
  { 13.4, 8, 15.2, 8 },
  { 2.9, 2.9, 4.15, 4.15 },
  { 11.85, 11.85, 13.1, 13.1 },
  { 13.1, 2.9, 11.85, 4.15 },
  { 4.15, 11.85, 2.9, 13.1 },
}
for _, ray in ipairs(sunRays) do
  sunElements[#sunElements + 1] = {
    type = "segments",
    action = "stroke",
    coordinates = {
      { x = ray[1], y = ray[2] },
      { x = ray[3], y = ray[4] },
    },
    strokeCapStyle = "round",
    strokeColor = iconColor,
    strokeWidth = 1.45,
  }
end

local themeIcons = {
  light = createTemplateIcon(sunElements),
  dark = createTemplateIcon({
    {
      type = "circle",
      action = "fill",
      center = { x = 7.4, y = 8 },
      radius = 5.5,
      fillColor = iconColor,
    },
    {
      type = "circle",
      action = "fill",
      center = { x = 10.1, y = 5.8 },
      radius = 5.1,
      fillColor = iconColor,
      compositeRule = "destinationOut",
    },
  }),
  automatic = createTemplateIcon({
    {
      type = "segments",
      action = "fill",
      closed = true,
      coordinates = {
        { x = 8, y = 2.3 },
        { x = 8, y = 13.7, c1x = 0.4, c1y = 3, c2x = 0.4, c2y = 13 },
      },
      fillColor = iconColor,
    },
    {
      type = "circle",
      action = "stroke",
      center = { x = 8, y = 8 },
      radius = 5.7,
      strokeColor = iconColor,
      strokeWidth = 1.35,
    },
  }),
}

local function automaticAppearanceEnabled()
  local output, ok = hs.execute(
    "/usr/bin/defaults read -g AppleInterfaceStyleSwitchesAutomatically 2>/dev/null"
  )

  return ok and output:match("^1%s*$") ~= nil
end

local function darkAppearanceEnabled()
  return hs.host.interfaceStyle() == "Dark"
end

local function setAutomaticAppearance(enabled)
  local _, ok = hs.execute(
    "/usr/bin/defaults write -g AppleInterfaceStyleSwitchesAutomatically -bool "
      .. (enabled and "true" or "false")
  )

  if not ok then
    hs.alert.show("Could not update automatic Appearance")
  end
end

local function setDarkAppearance(enabled)
  setAutomaticAppearance(false)

  local ok = hs.osascript.applescript(
    'tell application "System Events" to tell appearance preferences to set dark mode to '
      .. (enabled and "true" or "false")
  )

  if not ok then
    hs.alert.show("Allow Hammerspoon to control System Events")
  end
end

local function setAppearance(mode)
  if mode == "automatic" then
    setAutomaticAppearance(true)
  else
    setDarkAppearance(mode == "dark")
  end

  hs.timer.doAfter(0.3, function()
    if themeMenu then
      local current = darkAppearanceEnabled() and "Dark" or "Light"
      local automatic = automaticAppearanceEnabled()
      local icon = automatic and themeIcons.automatic
        or (current == "Dark" and themeIcons.dark or themeIcons.light)
      themeMenu:setIcon(icon, true)
      themeMenu:setTitle(nil)
      themeMenu:imagePosition(hs.menubar.imagePositions.imageOnly)
      themeMenu:setTooltip(
        automatic and ("Appearance: Automatic (currently " .. current .. ")")
          or ("Appearance: " .. current)
      )
    end
  end)
end

local function updateThemeMenu()
  if not themeMenu then
    return
  end

  local current = darkAppearanceEnabled() and "Dark" or "Light"
  local automatic = automaticAppearanceEnabled()
  local icon = automatic and themeIcons.automatic
    or (current == "Dark" and themeIcons.dark or themeIcons.light)

  themeMenu:setIcon(icon, true)
  themeMenu:setTitle(nil)
  themeMenu:imagePosition(hs.menubar.imagePositions.imageOnly)
  themeMenu:setTooltip(
    automatic and ("Appearance: Automatic (currently " .. current .. ")")
      or ("Appearance: " .. current)
  )
end

themeMenu = hs.menubar.new(true, "sean-machine-theme-switcher")
if themeMenu then
  themeMenu:setMenu(function()
    local dark = darkAppearanceEnabled()
    local automatic = automaticAppearanceEnabled()

    return {
      {
        title = "Light",
        checked = not automatic and not dark,
        fn = function() setAppearance("light") end,
      },
      {
        title = "Dark",
        checked = not automatic and dark,
        fn = function() setAppearance("dark") end,
      },
      {
        title = "Automatic",
        checked = automatic,
        fn = function() setAppearance("automatic") end,
      },
      { title = "-" },
      {
        title = "Toggle Light/Dark",
        fn = function() setAppearance(dark and "light" or "dark") end,
      },
    }
  end)
  updateThemeMenu()
end

hs.settings.set("seanMachineThemeSwitcherLoaded", themeMenu ~= nil)
hs.settings.set(
  "seanMachineThemeIconsLoaded",
  themeIcons.light ~= nil and themeIcons.dark ~= nil and themeIcons.automatic ~= nil
)

themeAppearanceWatcher = hs.distributednotifications.new(
  function() hs.timer.doAfter(0.2, updateThemeMenu) end,
  "AppleInterfaceThemeChangedNotification"
)
themeAppearanceWatcher:start()

-- Compact CPU monitor. Sampling is asynchronous so Hammerspoon remains
-- responsive while the percentage is measured.
local latestCpuUsage = nil
local cpuSampling = false

local cpuChipIcon = hs.image.imageFromASCII(
  ".....B.C.D.....\n" ..
  "...............\n" ..
  ".....B.C.D.....\n" ..
  "...1.......2...\n" ..
  "...............\n" ..
  "H.H.........K.K\n" ..
  "......6.7......\n" ..
  "I.I.........L.L\n" ..
  "......9.8......\n" ..
  "J.J.........M.M\n" ..
  "...............\n" ..
  "...4.......3...\n" ..
  ".....E.F.G.....\n" ..
  "...............\n" ..
  ".....E.F.G.....",
  {
    {
      fillColor = { alpha = 0 },
      strokeColor = { white = 0 },
      lineWidth = 1.4,
    },
    {
      fillColor = { white = 0 },
      strokeColor = { white = 0 },
      lineWidth = 1,
    },
    {
      fillColor = { alpha = 0 },
      strokeColor = { white = 0 },
      lineWidth = 1.4,
      shouldClose = false,
    },
  }
)
if cpuChipIcon then
  cpuChipIcon:size({ w = 14, h = 14 }, true):template(true)
end

local function compactMonitorTitle(text)
  return hs.styledtext.new(text, {
    font = { name = ".AppleSystemUIFont", size = 10 },
  })
end

local function updateCpuMenu(stats)
  latestCpuUsage = stats

  if not cpuMenu or not stats or not stats.overall then
    return
  end

  cpuMenu:setTitle(compactMonitorTitle(
    string.format("%d%%", math.floor(stats.overall.active + 0.5))
  ))
  cpuMenu:setTooltip(string.format(
    "CPU usage: %.1f%% (user %.1f%%, system %.1f%%)",
    stats.overall.active,
    stats.overall.user,
    stats.overall.system
  ))
end

local function sampleCpuUsage()
  if cpuSampling then
    return
  end

  cpuSampling = true
  cpuSampleRequest = hs.host.cpuUsage(0.75, function(stats)
    cpuSampling = false
    updateCpuMenu(stats)
  end)
end

cpuMenu = hs.menubar.new(true, "sean-machine-cpu-monitor")
if cpuMenu then
  if cpuChipIcon then
    cpuMenu:setIcon(cpuChipIcon, true)
    cpuMenu:imagePosition(hs.menubar.imagePositions.imageLeading)
  end
  cpuMenu:setTitle(compactMonitorTitle("…"))
  cpuMenu:setTooltip("Measuring CPU usage")
  cpuMenu:setMenu(function()
    if not latestCpuUsage then
      return { { title = "Measuring CPU usage…", disabled = true } }
    end

    local overall = latestCpuUsage.overall
    local cores = {}
    for index = 1, latestCpuUsage.n do
      local core = latestCpuUsage[index]
      cores[#cores + 1] = {
        title = string.format("Core %d: %.1f%%", index, core.active),
      }
    end

    return {
      {
        title = string.format("Overall: %.1f%%", overall.active),
      },
      {
        title = string.format("User: %.1f%%", overall.user),
      },
      {
        title = string.format("System: %.1f%%", overall.system),
      },
      {
        title = string.format("Idle: %.1f%%", overall.idle),
      },
      { title = "-" },
      { title = "Per Core", menu = cores },
      { title = "-" },
      {
        title = "Open Activity Monitor",
        fn = function() hs.application.launchOrFocus("Activity Monitor") end,
      },
    }
  end)
end

hs.settings.set("seanMachineCpuMonitorLoaded", cpuMenu ~= nil)
hs.settings.set("seanMachineCpuIconLoaded", cpuChipIcon ~= nil)
sampleCpuUsage()
cpuUsageTimer = hs.timer.doEvery(3, sampleCpuUsage)

-- Compact memory monitor. The used value follows the categories shown by
-- Activity Monitor: app/anonymous memory, wired memory, and compressed memory.
local latestMemoryUsage = nil

local function bytesForPages(stats, key)
  return (stats[key] or 0) * stats.pageSize
end

local function gibibytes(bytes)
  return bytes / (1024 * 1024 * 1024)
end

local function sampleMemoryUsage()
  local stats = hs.host.vmStat()
  if not stats or not stats.memSize or not stats.pageSize then
    return
  end

  local appBytes = bytesForPages(stats, "anonymousPages")
  local wiredBytes = bytesForPages(stats, "pagesWiredDown")
  local compressedBytes = bytesForPages(stats, "pagesUsedByVMCompressor")
  local usedBytes = math.min(
    stats.memSize,
    appBytes + wiredBytes + compressedBytes
  )

  latestMemoryUsage = {
    appBytes = appBytes,
    availableBytes = math.max(0, stats.memSize - usedBytes),
    cachedBytes = bytesForPages(stats, "fileBackedPages"),
    compressedBytes = compressedBytes,
    percent = usedBytes / stats.memSize * 100,
    totalBytes = stats.memSize,
    usedBytes = usedBytes,
    wiredBytes = wiredBytes,
  }

  if not memoryMenu then
    return
  end

  memoryMenu:setTitle(compactMonitorTitle(string.format(
    "RAM %d%%",
    math.floor(latestMemoryUsage.percent + 0.5)
  )))
  memoryMenu:setTooltip(string.format(
    "Memory usage: %.1f GiB of %.1f GiB (%.1f%%)",
    gibibytes(usedBytes),
    gibibytes(stats.memSize),
    latestMemoryUsage.percent
  ))
end

memoryMenu = hs.menubar.new(true, "sean-machine-memory-monitor")
if memoryMenu then
  memoryMenu:setTitle(compactMonitorTitle("RAM …"))
  memoryMenu:setTooltip("Measuring memory usage")
  memoryMenu:setMenu(function()
    if not latestMemoryUsage then
      return { { title = "Measuring memory usage…", disabled = true } }
    end

    local memory = latestMemoryUsage
    return {
      {
        title = string.format(
          "Used: %.1f GiB (%.1f%%)",
          gibibytes(memory.usedBytes),
          memory.percent
        ),
      },
      {
        title = string.format(
          "Available: %.1f GiB",
          gibibytes(memory.availableBytes)
        ),
      },
      { title = "-" },
      {
        title = string.format(
          "App Memory: %.1f GiB",
          gibibytes(memory.appBytes)
        ),
      },
      {
        title = string.format(
          "Wired Memory: %.1f GiB",
          gibibytes(memory.wiredBytes)
        ),
      },
      {
        title = string.format(
          "Compressed: %.1f GiB",
          gibibytes(memory.compressedBytes)
        ),
      },
      {
        title = string.format(
          "Cached Files: %.1f GiB",
          gibibytes(memory.cachedBytes)
        ),
      },
      {
        title = string.format(
          "Physical Memory: %.1f GiB",
          gibibytes(memory.totalBytes)
        ),
      },
      { title = "-" },
      {
        title = "Open Activity Monitor",
        fn = function() hs.application.launchOrFocus("Activity Monitor") end,
      },
    }
  end)
end

hs.settings.set("seanMachineMemoryMonitorLoaded", memoryMenu ~= nil)
sampleMemoryUsage()
memoryUsageTimer = hs.timer.doEvery(3, sampleMemoryUsage)

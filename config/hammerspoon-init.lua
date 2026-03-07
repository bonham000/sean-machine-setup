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

# Environment for the isolated Ghostty shell.

export BUN_INSTALL="$HOME/.bun"

typeset -U path PATH
path=(
  /opt/homebrew/bin
  /opt/homebrew/sbin
  "$BUN_INSTALL/bin"
  "$HOME/.local/bin"
  "$HOME/bin"
  "$HOME/.local/share/fnm/aliases/default/bin"
  "$HOME/.cargo/bin"
  "$HOME/.local/share/solana/install/active_release/bin"
  /Library/Frameworks/Python.framework/Versions/3.11/bin
  "$HOME/.kimi-code/bin"
  $path
)

if [[ -d /opt/homebrew/opt/openjdk@17 ]]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17
  path=("$JAVA_HOME/bin" $path)
fi

if [[ -d "$HOME/Library/Android/sdk" ]]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
  path+=(
    "$ANDROID_HOME/platform-tools"
    "$ANDROID_HOME/emulator"
    "$ANDROID_HOME/cmdline-tools/latest/bin"
  )
fi

if [[ -d /workspace ]]; then
  export UV_CACHE_DIR=/workspace/.uv-cache
fi

export EDITOR=vim
export VISUAL=vim
export ENABLE_BUILD_CSS_PRE_COMMIT_HOOK=true

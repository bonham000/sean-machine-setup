#!/bin/bash

mkdir -p ~/.local/bin

pushd ~/.local
# Trap errors and ensure we return to original directory
trap 'popd' ERR EXIT


# Add ~/.local/bin to PATH if not already present
if ! grep -q "export PATH=\"\$HOME/.local/bin:\$PATH\"" ~/.bashrc; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
    export PATH="$HOME/.local/bin:$PATH"
fi

sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d

if command -v task &> /dev/null; then
    echo "✅ Task successfully installed!"
    echo -e "\n\nsource ~/.bashrc"
else
    echo "❌ Task installation failed. Please check your PATH and try again."
    exit 1
fi
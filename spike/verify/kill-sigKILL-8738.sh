export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
exec mise exec -- node /mnt/d/project/dsh1/vendor/dsh-remote-wsl/spike/daemon.ts --port 8738 --version 0.2.0-rc.2 --cwd /home/g --idle-ms 600000

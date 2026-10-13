echo '--- failed units ---'; systemctl --failed --no-legend 2>/dev/null | head -10
echo '--- unit state ---'; systemctl is-failed dsh-rwsl-8911.service 2>&1
echo '--- reset-failed ---'; systemctl reset-failed 'dsh-rwsl-8911.service' 2>&1; echo rc=$?
echo '--- after reset is-failed ---'; systemctl is-failed dsh-rwsl-8911.service 2>&1
echo '--- state dir ---'; ls ~/.dsh/remote-wsl/ 2>/dev/null
echo '--- 8911 listen count ---'; ss -ltn 2>/dev/null | grep -c ':8911 '

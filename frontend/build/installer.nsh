!macro customInstall
  ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /install /quiet /norestart'
  
  # Add inbound firewall rules to allow local network clients to connect to these services
  nsExec::ExecToStack 'netsh advfirewall firewall add rule name="Station Monitor Backend" dir=in action=allow program="$INSTDIR\resources\backend\StationOS.Api.exe" enable=yes profile=any'
  nsExec::ExecToStack 'netsh advfirewall firewall add rule name="Station Monitor Go2RTC" dir=in action=allow program="$INSTDIR\resources\go2rtc\go2rtc.exe" enable=yes profile=any'
  nsExec::ExecToStack 'netsh advfirewall firewall add rule name="Station Monitor Database" dir=in action=allow program="$INSTDIR\resources\pg_portable\bin\postgres.exe" enable=yes profile=any'
!macroend

!macro customUninstall
  # Clean up the inbound firewall rules on uninstallation
  nsExec::ExecToStack 'netsh advfirewall firewall delete rule name="Station Monitor Backend"'
  nsExec::ExecToStack 'netsh advfirewall firewall delete rule name="Station Monitor Go2RTC"'
  nsExec::ExecToStack 'netsh advfirewall firewall delete rule name="Station Monitor Database"'
!macroend

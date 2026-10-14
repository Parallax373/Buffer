; Installer hooks.
; The background recorder is a separate program: stop it before its files are replaced or removed.
; It is started (and registered to start with Windows) by the app's first-run setup, so nothing is
; recorded before the user has seen and accepted the settings.

!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\buffer-recorder.exe" 0 +2
    ExecWait '"$INSTDIR\buffer-recorder.exe" quit'
  Sleep 1500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$INSTDIR\buffer-recorder.exe" quit'
  ExecWait '"$INSTDIR\buffer-recorder.exe" uninstall-autostart'
  Sleep 1500
!macroend

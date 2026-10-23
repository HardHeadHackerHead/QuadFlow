; QuadFlow NSIS installer hooks
;
; Wired into tauri.conf.json via:
;   bundle.windows.nsis.installerHooks = "./nsis/installer-hooks.nsh"
;
; On install: append the install directory to the per-user PATH
;   (HKCU\Environment\Path) and broadcast WM_SETTINGCHANGE so newly-spawned
;   shells pick up the change without a reboot. Per-user means no admin
;   prompt for installMode = currentUser.
;
; On uninstall: remove that same entry.
;
; The same logic is implemented in cli_install.rs for users who installed
; before this hook existed (or who toggle it from Settings → Integrations).
; Both write the exact same value, so they're idempotent — running one
; after the other won't double-add or fight each other.

; StrFunc.nsh provides ${StrStr} and ${StrRep}. We need to "claim" each
; function at the top level (before any macro/section references it).
; Tauri's generated installer.nsi already does `!include "StrFunc.nsh"`
; and claims its own (`${StrCase}`, `${StrLoc}`) using the old-style
; syntax, so we use the same syntax here for compatibility with whatever
; StrFunc.nsh version ships with the bundled makensis.
;
; NSIS uninstall sections can ONLY call functions prefixed with `un.`,
; so StrFunc ships separate ${UnStrRep} / ${UnStrStr} variants. The
; postinstall hook uses ${StrStr}; the preuninstall hook uses ${UnStrRep}
; — claim both family members here so each is wired up correctly.
${StrStr}
${UnStrRep}

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  Push $2
  ; Read current per-user Path
  ReadRegStr $0 HKCU "Environment" "Path"
  ; Already present? Skip.
  ${StrStr} $1 $0 "$INSTDIR"
  StrCmp $1 "" 0 cli_path_done
  ; Append (with leading semicolon if non-empty)
  StrCmp $0 "" 0 +3
    StrCpy $2 "$INSTDIR"
    Goto cli_path_write
  StrCpy $2 "$0;$INSTDIR"
  cli_path_write:
    WriteRegExpandStr HKCU "Environment" "Path" "$2"
    ; Broadcast environment change to running processes
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  cli_path_done:
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Push $0
  Push $1
  Push $2
  Push $3
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCmp $0 "" cli_unpath_done
  ; Try ";$INSTDIR" first (most common position: not first).
  ; Uninstall sections must call functions prefixed `un.` — StrFunc's
  ; ${UnStrRep} expands to those, so we use it here instead of ${StrRep}.
  ${UnStrRep} $1 $0 ";$INSTDIR" ""
  StrCmp $1 $0 0 cli_unpath_save
  ; Try "$INSTDIR;" (first in PATH)
  ${UnStrRep} $1 $0 "$INSTDIR;" ""
  StrCmp $1 $0 0 cli_unpath_save
  ; Try "$INSTDIR" alone (only entry)
  ${UnStrRep} $1 $0 "$INSTDIR" ""
  StrCmp $1 $0 cli_unpath_done
  cli_unpath_save:
    WriteRegExpandStr HKCU "Environment" "Path" "$1"
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  cli_unpath_done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

package main

import (
	"fmt"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Ctrl+Alt+Del (Secure Attention Sequence) nie da się wysłać przez SendInput — Windows przyjmuje
// je tylko od usługi przez SendSAS z sas.dll, i to wyłącznie, gdy zasada SoftwareSASGeneration
// na to pozwala (1 = usługi, 3 = usługi i ułatwienia dostępu). Usługa agenta działa jako SYSTEM.

const sasSupported = true

var procSendSAS = windows.NewLazySystemDLL("sas.dll").NewProc("SendSAS")

func sendSAS() error {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("zasada SoftwareSASGeneration: %w", err)
	}
	defer k.Close()
	switch v, _, err := k.GetIntegerValue("SoftwareSASGeneration"); {
	case err != nil || v == 0:
		err = k.SetDWordValue("SoftwareSASGeneration", 1)
	case v == 2: // tylko ułatwienia dostępu -> także usługi
		err = k.SetDWordValue("SoftwareSASGeneration", 3)
	default:
		err = nil
	}
	if err != nil {
		return fmt.Errorf("zasada SoftwareSASGeneration: %w", err)
	}
	if err := procSendSAS.Find(); err != nil {
		return fmt.Errorf("sas.dll: %w", err)
	}
	_, _, _ = procSendSAS.Call(0) // FALSE — wywołuje usługa, nie aplikacja użytkownika
	return nil
}

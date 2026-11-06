package main

import (
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Haki niskiego poziomu (WH_MOUSE_LL / WH_KEYBOARD_LL) widzą każde zdarzenie myszy i klawiatury
// w sesji; wstrzyknięte (SendInput agenta, inne programy zdalne) mają flagę INJECTED.

var (
	procSetWindowsHookExW   = user32.NewProc("SetWindowsHookExW")
	procCallNextHookEx      = user32.NewProc("CallNextHookEx")
	procUnhookWindowsHookEx = user32.NewProc("UnhookWindowsHookEx")
	procGetMessageW         = user32.NewProc("GetMessageW")
)

const (
	whKeyboardLL  = 13
	whMouseLL     = 14
	llmhfInjected = 0x01
	llkhfInjected = 0x10
)

type msllHook struct {
	x, y      int32
	mouseData uint32
	flags     uint32
	time      uint32
	extra     uintptr
}

type kbdllHook struct {
	vk, scan uint32
	flags    uint32
	time     uint32
	extra    uintptr
}

func startLocalInputWatch() bool {
	ok := make(chan bool, 1)
	go func() {
		// hak działa w wątku, który go założył i obsługuje jego kolejkę komunikatów
		runtime.LockOSThread()
		mouse := windows.NewCallback(func(code, wp uintptr, lp *msllHook) uintptr {
			if int32(code) >= 0 && lp.flags&llmhfInjected == 0 {
				markLocalInput()
			}
			r, _, _ := procCallNextHookEx.Call(0, code, wp, uintptr(unsafe.Pointer(lp)))
			return r
		})
		kbd := windows.NewCallback(func(code, wp uintptr, lp *kbdllHook) uintptr {
			if int32(code) >= 0 && lp.flags&llkhfInjected == 0 {
				markLocalInput()
			}
			r, _, _ := procCallNextHookEx.Call(0, code, wp, uintptr(unsafe.Pointer(lp)))
			return r
		})
		var mod windows.Handle
		_ = windows.GetModuleHandleEx(0, nil, &mod)
		hm, _, errM := procSetWindowsHookExW.Call(whMouseLL, mouse, uintptr(mod), 0)
		hk, _, errK := procSetWindowsHookExW.Call(whKeyboardLL, kbd, uintptr(mod), 0)
		if hm == 0 || hk == 0 {
			helperLogHook("pierwszeństwo dla osoby przy komputerze niedostępne: " + errM.Error() + " / " + errK.Error())
			for _, h := range []uintptr{hm, hk} {
				if h != 0 {
					_, _, _ = procUnhookWindowsHookEx.Call(h)
				}
			}
			ok <- false
			return
		}
		ok <- true
		var msg [48]byte // MSG
		for {
			if r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0); int32(r) <= 0 {
				return
			}
		}
	}()
	return <-ok
}

package main

import "os/user"

// currentUser — konto, na którym działa agent (i jego terminale): zwykle root / NT AUTHORITY\SYSTEM.
func currentUser() string {
	if u, err := user.Current(); err == nil {
		return u.Username
	}
	return ""
}

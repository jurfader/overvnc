//go:build !windows && !darwin

package main

func startLocalInputWatch() bool { return desktopTestMode() && testLocalInput() }

package main

import (
	"bufio"
	"bytes"
	"strings"
)

// parsePackages parsuje wyjście menedżerów pakietów Linuksa (dpkg-query, rpm, pacman, apk).
// Bez ograniczenia platformy, żeby dało się go testować na każdym systemie.
func parsePackages(manager string, out []byte) []Software {
	var list []Software
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var f []string
		switch manager {
		case "pacman":
			f = strings.SplitN(line, " ", 2)
		case "apk":
			// format: nazwa-wersja-rN
			if i := strings.LastIndex(line, "-r"); i > 0 {
				if j := strings.LastIndex(line[:i], "-"); j > 0 {
					f = []string{line[:j], line[j+1:]}
				}
			}
			if f == nil {
				f = []string{line}
			}
		default:
			f = strings.Split(line, "\t")
		}
		sw := Software{Name: f[0]}
		if len(f) > 1 {
			sw.Version = f[1]
		}
		if len(f) > 2 && f[2] != "(none)" {
			sw.Publisher = f[2]
		}
		list = append(list, sw)
	}
	return list
}

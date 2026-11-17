package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt-in native Windows acceptance of the COMPLETE official-derived package.
// The signature uses a random test-only key, never the production trust root.
func TestManagedCodexOfficialPackageFixture(t *testing.T) {
	directory := os.Getenv("ONE_CODEX_PACKAGE_FIXTURE_DIR")
	if directory == "" {
		t.Skip("official package fixture not supplied")
	}
	data, err := os.ReadFile(filepath.Join(directory, "unsigned-catalog-review.json"))
	if err != nil {
		t.Fatal(err)
	}
	var catalog managedCodexCatalog
	if err = json.Unmarshal(data, &catalog); err != nil || len(catalog.Releases) != 1 {
		t.Fatalf("bad fixture catalog: %v", err)
	}
	release := catalog.Releases[0]
	archive, err := os.ReadFile(filepath.Join(directory, filepath.Base(release.URL)))
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	envelope := managedCodexEnvelope{Payload: base64.RawURLEncoding.EncodeToString(data), Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, data))}
	publicRaw := base64.RawURLEncoding.EncodeToString(public)
	verified, err := verifyManagedCodex(envelope, publicRaw, "https://theone.aiarrival.cn", release.Version)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "executors")
	started := time.Now()
	entry, err := commitManagedCodex(archive, envelope, verified, root, func(executable, version string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		output, err := exec.CommandContext(ctx, executable, "--version").CombinedOutput()
		if err != nil {
			return err
		}
		if !strings.Contains(string(output), version) {
			t.Fatal("actual executable version differs")
		}
		return nil
	}, func(source, target string) error { return os.Rename(source, target) })
	if err != nil {
		t.Fatal(err)
	}
	recovered, version, err := installedManagedCodex(root, publicRaw, "https://theone.aiarrival.cn")
	if err != nil || recovered != entry || version != release.Version {
		t.Fatalf("actual installed package unavailable after reconstruction: %v", err)
	}
	// A bundled dependency, not just codex.exe, remains covered by verification.
	dependency := filepath.Join(filepath.Dir(filepath.Dir(entry)), "codex-resources", "voice", "bin", "glib-2.0-0.dll")
	if err = os.WriteFile(dependency, []byte("synthetic changed DLL"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = installedManagedCodex(root, publicRaw, "https://theone.aiarrival.cn"); err == nil {
		t.Fatal("changed official dependency accepted")
	}
	t.Logf("native signed fixture installed %s, reconstructed and rejected changed DLL in %s", release.Version, time.Since(started).Round(time.Millisecond))
}

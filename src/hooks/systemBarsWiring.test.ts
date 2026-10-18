// The Android status bar colour passes through three layers: the web page calls a Tauri command,
// the Rust command calls a Kotlin plugin method, and the Kotlin method changes the window. The
// layers are joined only by names, and none of the languages checks the others, so a rename in
// one place would silently stop the icons changing. These read the three sources and check the
// names still agree. The Android code itself can only be tried on a phone.

// The project has no Node type definitions, so the two things used here are described by hand.
declare const __dirname: string;
const { readFileSync } = jest.requireActual("fs") as { readFileSync(path: string, encoding: string): string };

const read = (...parts: string[]) =>
  readFileSync([__dirname, "..", "..", ...parts].join("/"), "utf8").replace(/\r\n/g, "\n");

const theme = read("src", "hooks", "useTheme.ts");
const rustCommand = read("src-tauri", "src", "commands", "files.rs");
const rustMain = read("src-tauri", "src", "lib.rs");
const kotlin = read("src-tauri", "gen", "android", "app", "src", "main", "java", "com", "qre", "locker", "OpenFilePlugin.kt");

describe("Android status bar wiring", () => {
  it("the page calls the command by the name Rust registers", () => {
    expect(theme).toContain('invoke("set_android_system_bars"');
    expect(rustCommand).toContain("pub fn set_android_system_bars(");
    expect(rustMain).toContain("commands::files::set_android_system_bars,");
  });

  it("the page sends the argument under the name Rust expects, in camel case", () => {
    expect(theme).toContain("{ lightBackground: light }");
    expect(rustCommand).toMatch(/set_android_system_bars\(app: AppHandle, light_background: bool\)/);
  });

  it("Rust calls the Kotlin method by the name Kotlin declares, with the argument it reads", () => {
    expect(rustCommand).toContain('"setSystemBars"');
    expect(rustCommand).toContain('serde_json::json!({ "lightBackground": light_background })');
    expect(kotlin).toMatch(/@Command\s+fun setSystemBars\(invoke: Invoke\)/);
    expect(kotlin).toMatch(/class SystemBarsArgs\s*{\s*var lightBackground: Boolean/);
  });

  it("Kotlin sets both bars, from the argument, on the screen's own thread", () => {
    expect(kotlin).toContain("activity.runOnUiThread");
    expect(kotlin).toContain("controller.isAppearanceLightStatusBars = args.lightBackground");
    expect(kotlin).toContain("controller.isAppearanceLightNavigationBars = args.lightBackground");
  });

  it("the command is a quiet success on a computer, so the page needs no platform check", () => {
    const body = rustCommand.slice(rustCommand.indexOf("pub fn set_android_system_bars("));
    const notAndroid = body.slice(body.indexOf('#[cfg(not(target_os = "android"))]'), body.indexOf('#[cfg(target_os = "android")]'));
    expect(notAndroid).toContain("Ok(())");
  });
});

// Makes this file a module, so its helper names do not clash with those of other test files.
export {};

// DLSS5Injector -- a small, honest DLL injector for OptiScaler / DLSS-NR.
//
// WHAT IT IS FOR
//   Single-player games only. It launches a game and loads OptiScaler into it as
//   OptiScaler.dll -- the injection ("ASI plugin") mode OptiScaler's own dllmain.cpp
//   already supports -- instead of renaming a system DLL on disk. Because nothing on
//   disk is renamed, it does NOT fight ReShade for the dxgi.dll slot: ReShade keeps
//   its proxy, OptiScaler is injected, both run.
//
// WHAT IT IS NOT
//   It is not a way past anti-cheat. Remote-thread injection is exactly what EAC and
//   BattlEye are built to catch. This tool refuses to launch a game that ships a known
//   anti-cheat, and there is deliberately no override flag. Do not use it online.
//
// HOW IT INJECTS (and why not the way the napkin sketch said)
//   The sketch was: launch suspended -> inject -> resume. You cannot inject at
//   CREATE_SUSPENDED: the target's loader has not run yet, so a remote LoadLibraryW
//   runs against an uninitialised loader and crashes or deadlocks. So instead:
//       CreateProcess(CREATE_SUSPENDED)    -- a clean handle, nothing loaded yet
//       ResumeThread                       -- let the loader initialise
//       wait for the process to settle     -- WaitForInputIdle, then a short poll
//       CreateRemoteThread -> LoadLibraryW -- standard, documented, non-stealth
//   A few hundred ms "late" is fine: OptiScaler installs its hooks lazily and the
//   upscaler is not created until a save is loaded anyway.
//
// BUILD (x64, from a "x64 Native Tools for VS" prompt):
//       cl /std:c++17 /EHsc /O2 /Fe:DLSS5Injector.exe DLSS5Injector.cpp
//   The libs it needs (user32, psapi) are pinned below with #pragma comment, so no
//   /link line is required. 64-bit only; every DLSS title is x64.
//
// USAGE
//       DLSS5Injector.exe [--dll <OptiScaler.dll>] [--] <game.exe> [game args...]
//   Options come first; the first non-option token is the game exe; everything after it
//   is passed to the game verbatim. --dll defaults to OptiScaler.dll next to the injector.
//
// STEAM ("our UI sets this once, then Steam does the rest"):
//   Set the game's Launch Options to:
//       "C:\Tools\DLSS5Injector.exe" --dll "C:\...\OptiScaler.dll" -- %command%
//   Steam expands %command% to the real game command line, so the injector wraps the
//   game Steam would have run -- playtime, overlay and cloud saves all keep working.
//   The trailing "--" matters: it stops the game's own switches being read as ours.

#include <windows.h>
#include <psapi.h>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

#pragma comment(lib, "user32.lib") // WaitForInputIdle
#pragma comment(lib, "psapi.lib")  // EnumProcessModulesEx

namespace fs = std::filesystem;

static void fail(const std::string& msg, bool withLastError = true) {
    std::cerr << "DLSS5Injector: " << msg;
    if (withLastError) {
        DWORD e = GetLastError();
        if (e) std::cerr << " (GetLastError=" << e << ")";
    }
    std::cerr << "\n";
}

// Anti-cheat files that commonly sit in a game's tree. If any is present we refuse:
// injecting into an anti-cheat-protected game is a ban risk, and this tool will not be
// the thing that tries to sneak past one. No override flag, on purpose.
static const wchar_t* kAntiCheatMarkers[] = {
    L"EasyAntiCheat",        L"start_protected_game", L"BEService",
    L"BattlEye",             L"anticheat",            L"Anti-Cheat",
    L"vgc.exe",              L"vgtray.exe", // Vanguard
};

static bool looksLikeAntiCheat(const fs::path& gameExe) {
    std::error_code ec;
    fs::path root = gameExe.parent_path();
    for (auto it = fs::recursive_directory_iterator(
             root, fs::directory_options::skip_permission_denied, ec);
         it != fs::recursive_directory_iterator(); it.increment(ec)) {
        if (ec) { ec.clear(); continue; }
        if (it.depth() > 3) { it.disable_recursion_pending(); continue; }
        std::wstring name = it->path().filename().wstring();
        for (auto& c : name) c = (wchar_t)towlower(c);
        for (const wchar_t* m : kAntiCheatMarkers) {
            std::wstring needle(m);
            for (auto& c : needle) c = (wchar_t)towlower(c);
            if (name.find(needle) != std::wstring::npos) return true;
        }
    }
    return false;
}

// LoadLibraryW lives in kernel32, mapped at the same base in every process of a boot
// session, so its address in us is its address in the target.
static LPTHREAD_START_ROUTINE remoteLoadLibraryW() {
    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    if (!k32) return nullptr;
    return reinterpret_cast<LPTHREAD_START_ROUTINE>(GetProcAddress(k32, "LoadLibraryW"));
}

// Give the freshly-resumed process a moment to finish its own loader init before we
// create a remote thread in it. WaitForInputIdle handles GUI apps; the poll is a
// floor for everything else.
static void waitForProcessInit(HANDLE hProcess) {
    WaitForInputIdle(hProcess, 4000); // returns fast for most GUI games; harmless otherwise
    // Floor: ensure the module list is populated (loader has run) before injecting.
    for (int i = 0; i < 40; ++i) {           // up to ~4s
        HMODULE mods[8];
        DWORD needed = 0;
        if (EnumProcessModulesEx(hProcess, mods, sizeof(mods), &needed, LIST_MODULES_ALL)
            && needed >= sizeof(HMODULE) * 3) // ntdll + kernel32 + at least one more
            break;
        Sleep(100);
    }
}

static bool inject(HANDLE hProcess, const fs::path& dll) {
    const std::wstring path = fs::absolute(dll).wstring();
    const SIZE_T bytes = (path.size() + 1) * sizeof(wchar_t);

    LPTHREAD_START_ROUTINE loadLib = remoteLoadLibraryW();
    if (!loadLib) { fail("could not resolve LoadLibraryW"); return false; }

    LPVOID remote = VirtualAllocEx(hProcess, nullptr, bytes, MEM_COMMIT | MEM_RESERVE,
                                   PAGE_READWRITE);
    if (!remote) { fail("VirtualAllocEx failed"); return false; }

    if (!WriteProcessMemory(hProcess, remote, path.c_str(), bytes, nullptr)) {
        fail("WriteProcessMemory failed");
        VirtualFreeEx(hProcess, remote, 0, MEM_RELEASE);
        return false;
    }

    HANDLE hThread = CreateRemoteThread(hProcess, nullptr, 0, loadLib, remote, 0, nullptr);
    if (!hThread) {
        fail("CreateRemoteThread failed");
        VirtualFreeEx(hProcess, remote, 0, MEM_RELEASE);
        return false;
    }

    WaitForSingleObject(hThread, INFINITE);

    // On x64 the thread exit code is only the low 32 bits of LoadLibraryW's HMODULE,
    // so 0 reliably means failure but non-zero cannot fully confirm the handle. Good
    // enough as a smoke check; the real confirmation is OptiScaler's own log file.
    DWORD exitCode = 0;
    GetExitCodeThread(hThread, &exitCode);
    CloseHandle(hThread);
    VirtualFreeEx(hProcess, remote, 0, MEM_RELEASE);

    if (exitCode == 0) {
        fail("remote LoadLibraryW returned NULL -- the DLL failed to load", false);
        return false;
    }
    return true;
}

// Build a mutable command line: "game.exe" arg1 arg2 ...  (CreateProcessW needs a
// writable buffer, and argv[0] must be quoted in case the path has spaces.)
static std::wstring buildCommandLine(const fs::path& exe,
                                     const std::vector<std::wstring>& args) {
    std::wstring cl = L"\"" + fs::absolute(exe).wstring() + L"\"";
    for (const auto& a : args) cl += L" " + a;
    return cl;
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 2) {
        std::wcerr << L"usage: DLSS5Injector.exe [--dll <OptiScaler.dll>] [--] "
                      L"<game.exe> [game args...]\n";
        return 2;
    }

    fs::path gameExe;                   // first non-option token
    fs::path dll;                       // resolved below
    std::vector<std::wstring> gameArgs;

    // Parse leading options only until we meet the game exe. Once the exe is known,
    // every remaining token is the game's own -- passed through untouched, never
    // re-interpreted as ours. This is what makes Steam's `-- %command%` work: after the
    // `--` separator the first token is the real exe and the rest are the game's args.
    for (int i = 1; i < argc; ++i) {
        std::wstring a = argv[i];
        if (gameExe.empty()) {
            if (a == L"--dll" && i + 1 < argc) { dll = argv[++i]; continue; }
            if (a == L"--") continue;               // separator; exe is the next token
            gameExe = a;                            // first non-option token
        } else {
            gameArgs.emplace_back(a);               // verbatim, no further option parsing
        }
    }

    if (gameExe.empty()) { fail("no game executable given", false); return 2; }

    // Default DLL: OptiScaler.dll next to this injector executable.
    if (dll.empty()) {
        wchar_t self[MAX_PATH];
        GetModuleFileNameW(nullptr, self, MAX_PATH);
        dll = fs::path(self).parent_path() / L"OptiScaler.dll";
    }

    if (!fs::exists(gameExe)) { fail("game exe not found: " + gameExe.string(), false); return 1; }
    if (!fs::exists(dll))     { fail("OptiScaler.dll not found: " + dll.string(), false); return 1; }

    if (looksLikeAntiCheat(gameExe)) {
        std::wcerr << L"\nDLSS5Injector: this game appears to ship an anti-cheat.\n"
                      L"Injection into anti-cheat-protected games risks a ban and is refused.\n"
                      L"This tool is for single-player games only.\n\n";
        return 3;
    }

    std::wstring cmdline = buildCommandLine(gameExe, gameArgs);
    std::vector<wchar_t> cmdBuf(cmdline.begin(), cmdline.end());
    cmdBuf.push_back(L'\0');

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};

    // Launch suspended so we hold the process before it does anything, then resume and
    // inject once its loader has initialised (see the header comment for why we do not
    // inject while still suspended). Working directory = the game's folder, which many
    // games require to find their own data.
    if (!CreateProcessW(fs::absolute(gameExe).c_str(), cmdBuf.data(), nullptr, nullptr,
                        FALSE, CREATE_SUSPENDED, nullptr,
                        fs::absolute(gameExe).parent_path().c_str(), &si, &pi)) {
        fail("CreateProcess failed");
        return 1;
    }

    ResumeThread(pi.hThread);
    waitForProcessInit(pi.hProcess);

    bool ok = inject(pi.hProcess, dll);
    if (ok) {
        std::wcout << L"DLSS5Injector: injected " << fs::absolute(dll).wstring()
                   << L"\nCheck OptiScaler's log in the game folder to confirm it "
                      L"initialised as OptiScaler.dll.\n";
    }

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return ok ? 0 : 1;
}

; Inno Setup script - Advance Download Manager.  Built by scripts/release.js (ISCC /DAppVersion=x.y.z /DAppDir=<staged app folder> /DOutDir=...)
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef AppDir
  #define AppDir "..\build\app"
#endif
#ifndef OutDir
  #define OutDir "..\release"
#endif

[Setup]
AppId={{6F1D3A52-8E0B-4C7B-9A3E-AD11D0C2B7E4}
AppName=Advance Download Manager
AppVersion={#AppVersion}
AppPublisher=@kaushalsah606
AppPublisherURL=https://github.com/kaushalsah606/ADM---Advance-Download-Manager-
AppSupportURL=https://github.com/kaushalsah606/ADM---Advance-Download-Manager-/issues
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\Advance Download Manager
DefaultGroupName=Advance Download Manager
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir={#OutDir}
OutputBaseFilename=AdvanceDownloadManager-{#AppVersion}-win-x64-Setup
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\AdvanceDownloadManager.exe
LicenseFile=..\LICENSE
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
CloseApplications=force
RestartApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startup"; Description: "Start Advance Download Manager when I sign in to Windows"; GroupDescription: "Options:"

[Files]
Source: "{#AppDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Advance Download Manager"; Filename: "{app}\AdvanceDownloadManager.exe"
Name: "{group}\Browser extensions"; Filename: "{app}\browser-extension"
Name: "{group}\Uninstall Advance Download Manager"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Advance Download Manager"; Filename: "{app}\AdvanceDownloadManager.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Advance Download Manager"; ValueData: """{app}\AdvanceDownloadManager.exe"" --minimized"; Tasks: startup; Flags: uninsdeletevalue
; the app also registers itself the first time it runs; remove that value when uninstalling
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "Advance Download Manager"; Flags: dontcreatekey uninsdeletevalue

[Run]
Filename: "{app}\AdvanceDownloadManager.exe"; Description: "Launch Advance Download Manager"; Flags: nowait postinstall skipifsilent
Filename: "{app}\AdvanceDownloadManager.exe"; Parameters: "--setup-browsers"; Description: "Set up the browser extension (Chrome, Edge, Firefox)"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM AdvanceDownloadManager.exe /IM adm-engine.exe"; Flags: runhidden; RunOnceId: "StopADM"

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\Advance Download Manager"

[Code]
{ Ask a running instance to save its state and exit (POST /api/shutdown with the token from session.json). }
procedure StopRunningApp();
var
  Raw: AnsiString;
  Json, Port, Token: String;
  P, Q, I: Integer;
  Http: Variant;
begin
  if not LoadStringFromFile(ExpandConstant('{%USERPROFILE}\.advance-download-manager\session.json'), Raw) then Exit;
  Json := String(Raw);
  P := Pos('"port":', Json); if P = 0 then Exit;
  Port := Copy(Json, P + 7, 10); Q := 1;
  while (Q <= Length(Port)) and (Port[Q] >= '0') and (Port[Q] <= '9') do Q := Q + 1;
  Port := Copy(Port, 1, Q - 1);
  P := Pos('"token":"', Json); if P = 0 then Exit;
  Token := Copy(Json, P + 9, 200); Q := Pos('"', Token); if Q = 0 then Exit;
  Token := Copy(Token, 1, Q - 1);
  try
    Http := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    Http.Open('POST', 'http://127.0.0.1:' + Port + '/api/shutdown', False);
    Http.SetRequestHeader('X-Token', Token);
    Http.SetTimeouts(2000, 2000, 2000, 2000);
    Http.Send('{}');
    for I := 1 to 20 do begin Sleep(250); end;
  except
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningApp();
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  StopRunningApp();
  Result := True;
end;

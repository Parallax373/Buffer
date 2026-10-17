@echo off
rem Starts buffer-fans.exe from its own folder with the .NET profiler / startup-hook variables cleared:
rem the scheduled task inherits the (user-writable) environment of the signed-in user.
set CORECLR_ENABLE_PROFILING=
set COR_ENABLE_PROFILING=
set DOTNET_STARTUP_HOOKS=
set DOTNET_EnableDiagnostics=0
"%~dp0buffer-fans.exe" --pipe buffer-fans --sid %1

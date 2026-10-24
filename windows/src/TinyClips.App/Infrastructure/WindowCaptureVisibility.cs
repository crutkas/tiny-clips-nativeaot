using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.UI.Xaml;
using WinRT.Interop;

namespace TinyClips.App;

internal static class WindowCaptureVisibility
{
    public static CaptureVisibilityPolicy Policy { get; } = new(SetExcluded);

    public static void Register(Window window, bool alwaysExcluded = false)
    {
        var hwnd = WindowNative.GetWindowHandle(window);
        window.Closed += OnClosed;
        try
        {
            Policy.Register(hwnd, alwaysExcluded);
        }
        catch (CaptureVisibilityException)
        {
            window.Close();
            throw;
        }

        void OnClosed(object sender, WindowEventArgs args)
        {
            window.Closed -= OnClosed;
            Policy.Unregister(hwnd);
        }
    }

    private static void SetExcluded(nint hwnd, bool excluded)
    {
        if (!OverlayWindowHelpers.SetCaptureExcluded(hwnd, excluded))
        {
            throw new CaptureVisibilityException(Marshal.GetLastWin32Error(), excluded);
        }
    }
}

internal sealed class CaptureVisibilityException(int error, bool excluded)
    : Win32Exception(error, excluded
        ? "Windows could not exclude a Tiny Clips window from capture."
        : "Windows could not include a Tiny Clips window in capture.")
{
}

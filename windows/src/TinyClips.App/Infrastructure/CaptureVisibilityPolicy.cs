namespace TinyClips.App;

internal sealed class CaptureVisibilityPolicy(Action<nint, bool> setExcluded)
{
    private readonly Dictionary<nint, bool> _windows = [];

    public bool IncludeTinyClips { get; private set; }

    public void Register(nint hwnd, bool alwaysExcluded = false)
    {
        _windows.Add(hwnd, alwaysExcluded);
        // Private overlays apply exclusion themselves before showing, with fail-closed handling.
        if (!alwaysExcluded)
        {
            setExcluded(hwnd, !IncludeTinyClips);
        }
    }

    public void Unregister(nint hwnd) => _windows.Remove(hwnd);

    public bool CanSelectWindow(bool isOwnProcess, nint hwnd, nint pickerHwnd) =>
        hwnd != pickerHwnd
        && (!isOwnProcess || (IncludeTinyClips && !_windows.GetValueOrDefault(hwnd)));

    public void BeginCapture(bool includeTinyClips, bool recordingActive)
    {
        // Display affinity is process/window-wide, not scoped to a WGC session.
        if (recordingActive)
        {
            return;
        }

        IncludeTinyClips = includeTinyClips;
        foreach (var (hwnd, alwaysExcluded) in _windows)
        {
            setExcluded(hwnd, alwaysExcluded || !includeTinyClips);
        }
    }
}

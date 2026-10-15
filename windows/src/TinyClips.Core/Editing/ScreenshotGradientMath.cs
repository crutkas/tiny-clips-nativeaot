namespace TinyClips.Core.Editing;

/// <summary>Frame-relative endpoints for a gradient through the center of a frame.</summary>
public readonly record struct ScreenshotGradientEndpoints(PointD Start, PointD End);

/// <summary>Pure gradient direction geometry shared by the editor preview and export renderer.</summary>
public static class ScreenshotGradientMath
{
    /// <summary>
    /// Returns frame-relative endpoints whose axis matches <paramref name="degrees"/> in the
    /// frame's pixel space and whose projection spans every frame corner.
    /// </summary>
    public static ScreenshotGradientEndpoints Endpoints(double degrees, double width, double height)
    {
        if (!double.IsFinite(degrees))
        {
            throw new ArgumentOutOfRangeException(nameof(degrees));
        }
        if (!double.IsFinite(width) || width <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(width));
        }
        if (!double.IsFinite(height) || height <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(height));
        }

        var radians = degrees % 360 * Math.PI / 180;
        var directionX = Math.Cos(radians);
        var directionY = Math.Sin(radians);
        var halfLength = (Math.Abs(directionX) * width + Math.Abs(directionY) * height) / 2;
        var offsetX = directionX * halfLength / width;
        var offsetY = directionY * halfLength / height;

        return new ScreenshotGradientEndpoints(
            new PointD(0.5 - offsetX, 0.5 - offsetY),
            new PointD(0.5 + offsetX, 0.5 + offsetY));
    }
}

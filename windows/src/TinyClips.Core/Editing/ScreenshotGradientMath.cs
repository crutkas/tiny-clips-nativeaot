namespace TinyClips.Core.Editing;

/// <summary>Normalized endpoints for a gradient through the center of a unit square.</summary>
public readonly record struct ScreenshotGradientEndpoints(PointD Start, PointD End);

/// <summary>Pure gradient direction geometry shared by the editor preview and export renderer.</summary>
public static class ScreenshotGradientMath
{
    public static ScreenshotGradientEndpoints Endpoints(double degrees)
    {
        if (!double.IsFinite(degrees))
        {
            throw new ArgumentOutOfRangeException(nameof(degrees));
        }

        var radians = degrees % 360 * Math.PI / 180;
        var directionX = Math.Cos(radians);
        var directionY = Math.Sin(radians);
        var halfLength = Math.Min(
            0.5 / Math.Max(Math.Abs(directionX), 1e-12),
            0.5 / Math.Max(Math.Abs(directionY), 1e-12));

        return new ScreenshotGradientEndpoints(
            new PointD(0.5 - directionX * halfLength, 0.5 - directionY * halfLength),
            new PointD(0.5 + directionX * halfLength, 0.5 + directionY * halfLength));
    }
}

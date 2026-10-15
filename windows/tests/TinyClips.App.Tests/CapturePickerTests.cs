using System.Xml.Linq;

namespace TinyClips.App.Tests;

public sealed class CapturePickerTests
{
    [Fact]
    public void ScreenshotPicker_DoesNotDuplicateTrayTextRecognition()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Fixtures", "CapturePickerWindow.xaml");
        var document = XDocument.Load(path);
        XNamespace x = "http://schemas.microsoft.com/winfx/2006/xaml";

        var automationIds = document
            .Descendants()
            .Select(element => (string?)element.Attribute("AutomationProperties.AutomationId"))
            .Where(id => id is not null)
            .ToArray();
        var names = document
            .Descendants()
            .Select(element => (string?)element.Attribute(x + "Name"))
            .Where(name => name is not null)
            .ToArray();

        Assert.Contains("CaptureRegionButton", automationIds);
        Assert.Contains("CaptureScreenButton", automationIds);
        Assert.Contains("CaptureWindowButton", automationIds);
        Assert.Contains("CaptureScrollButton", automationIds);
        Assert.DoesNotContain("RecognizeTextButton", automationIds);
        Assert.DoesNotContain("RecognizeTextButton", names);
    }
}

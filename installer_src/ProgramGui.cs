using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using Path = System.Windows.Shapes.Path;

namespace VencordInstaller
{
    public class ProgramGui : Application
    {
        [STAThread]
        public static void Main()
        {
            ProgramGui app = new ProgramGui();
            app.Run(new MainWindow());
        }
    }

    public class MainWindow : Window
    {
        private List<DiscordInstall> _discords;
        private DiscordInstall _selectedDiscord;

        private TextBox _customPathBox;
        private Button _btnBrowse;
        private TextBlock _statusText;
        private Border _statusBanner;
        private Path _statusIcon;
        private TextBlock _selectedCardTitle;
        private TextBlock _selectedCardPath;
        private Border _selectedCardBorder;
        private Border _radioOuter;
        private Border _radioInner;

        private Button _btnInstall;
        private Button _btnRepair;
        private Button _btnUninstall;
        private Button _btnSettings;

        private Grid _mainGrid;
        private Grid _feedbackOverlay;
        private Path _feedbackIcon;
        private TextBlock _feedbackTitle;
        private TextBlock _feedbackSubtitle;
        private System.Windows.Threading.DispatcherTimer _feedbackTimer;

        // Path geometries
        private const string ICON_DISCORD = "M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09-.01-.02-.04-.03-.07-.03-1.5.26-2.93.71-4.27 1.33-.01 0-.02.01-.03.02-2.72 4.07-3.47 8.03-3.1 11.95 0 .02.01.04.03.05 1.8 1.32 3.53 2.12 5.24 2.65.03.01.06 0 .07-.02.4-.55.76-1.13 1.07-1.74.02-.04 0-.08-.04-.09-.57-.22-1.11-.48-1.64-.78-.04-.02-.04-.08-.01-.11.11-.08.22-.17.33-.25.02-.02.05-.02.07-.01 3.44 1.57 7.15 1.57 10.55 0 .02-.01.05-.01.07.01.11.09.22.17.33.26.04.03.04.09-.01.11-.52.31-1.07.56-1.64.78-.04.01-.05.06-.04.09.32.61.68 1.19 1.07 1.74.03.01.06.02.09.01 1.72-.53 3.45-1.33 5.25-2.65.02-.01.03-.03.03-.05.44-4.53-.73-8.46-3.1-11.95-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.83 2.12-1.89 2.12z";
        private const string ICON_PUZZLE = "M19 3H14.82C14.4 1.84 13.3 1 12 1S9.6 1.84 9.18 3H5C3.9 3 3 3.9 3 5V9.18C4.16 9.6 5 10.7 5 12S4.16 14.4 3 14.82V19C3 20.1 3.9 21 5 21H9.18C9.6 19.84 10.7 19 12 19S14.4 19.84 14.82 21H19C20.1 21 21 20.1 21 19V14.82C19.84 14.4 19 13.3 19 12S19.84 9.6 21 9.18V5C21 3.9 20.1 3 19 3Z";
        private const string ICON_SHIELD = "M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3z";
        private const string ICON_PIN = "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z";
        private const string ICON_FOLDER = "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z";
        private const string ICON_INFO = "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z";
        private const string ICON_GEAR = "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z";
        private const string ICON_DOWNLOAD = "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z";
        private const string ICON_WRENCH = "M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z";
        private const string ICON_TRASH = "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z";
        private const string ICON_SPARKLE = "M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z";

        public MainWindow()
        {
            Title = "iMCord Installer";
            Width = 980;
            Height = 640;
            MinWidth = 880;
            MinHeight = 580;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;

            LoadWindowIcon();
            BuildUi();
            RefreshDiscords();
        }

        private void LoadWindowIcon()
        {
            try
            {
                Assembly asm = Assembly.GetExecutingAssembly();
                foreach (string n in asm.GetManifestResourceNames())
                {
                    if (n.EndsWith("vencord.ico", StringComparison.OrdinalIgnoreCase))
                    {
                        using (Stream s = asm.GetManifestResourceStream(n))
                        {
                            if (s != null)
                            {
                                Icon = BitmapFrame.Create(s);
                                return;
                            }
                        }
                    }
                }
            }
            catch { }
        }

        private void BuildUi()
        {
            // Outer container with rounded corners and dark border
            Border rootBorder = new Border();
            rootBorder.CornerRadius = new CornerRadius(16);
            rootBorder.BorderThickness = new Thickness(1.5);
            rootBorder.BorderBrush = new SolidColorBrush(Color.FromRgb(40, 32, 60)); // #28203c

            LinearGradientBrush rootBg = new LinearGradientBrush();
            rootBg.StartPoint = new Point(0, 0);
            rootBg.EndPoint = new Point(1, 1);
            rootBg.GradientStops.Add(new GradientStop(Color.FromRgb(11, 9, 20), 0.0));
            rootBg.GradientStops.Add(new GradientStop(Color.FromRgb(17, 13, 31), 0.5));
            rootBg.GradientStops.Add(new GradientStop(Color.FromRgb(22, 16, 40), 1.0));
            rootBorder.Background = rootBg;
            rootBorder.ClipToBounds = true;

            rootBorder.Effect = new DropShadowEffect()
            {
                BlurRadius = 32,
                ShadowDepth = 0,
                Opacity = 0.65,
                Color = Colors.Black
            };

            Grid mainGrid = new Grid();
            mainGrid.RowDefinitions.Add(new RowDefinition() { Height = new GridLength(38) }); // Title bar
            mainGrid.RowDefinitions.Add(new RowDefinition() { Height = new GridLength(1, GridUnitType.Star) }); // Content
            mainGrid.RowDefinitions.Add(new RowDefinition() { Height = new GridLength(68) }); // Action bar

            // Title Bar
            Grid titleBar = BuildTitleBar();
            Grid.SetRow(titleBar, 0);
            mainGrid.Children.Add(titleBar);

            // Body Area (2 Columns)
            Grid bodyGrid = new Grid();
            bodyGrid.ColumnDefinitions.Add(new ColumnDefinition() { Width = new GridLength(260) });
            bodyGrid.ColumnDefinitions.Add(new ColumnDefinition() { Width = new GridLength(1, GridUnitType.Star) });

            Border sidebar = BuildSidebar();
            Grid.SetColumn(sidebar, 0);
            bodyGrid.Children.Add(sidebar);

            Border contentArea = BuildContentArea();
            Grid.SetColumn(contentArea, 1);
            bodyGrid.Children.Add(contentArea);

            Grid.SetRow(bodyGrid, 1);
            mainGrid.Children.Add(bodyGrid);

            // Action Bar
            Grid actionBar = BuildActionBar();
            Grid.SetRow(actionBar, 2);
            mainGrid.Children.Add(actionBar);

            _mainGrid = mainGrid;

            Grid rootLayer = new Grid();
            rootLayer.Children.Add(mainGrid);

            _feedbackOverlay = BuildFeedbackOverlay();
            rootLayer.Children.Add(_feedbackOverlay);

            rootBorder.Child = rootLayer;
            Content = rootBorder;
        }

        private Grid BuildTitleBar()
        {
            Grid bar = new Grid();
            bar.Background = Brushes.Transparent;
            bar.MouseDown += (s, e) => {
                if (e.LeftButton == MouseButtonState.Pressed) DragMove();
            };

            // Left branding: icon + title
            StackPanel left = new StackPanel();
            left.Orientation = Orientation.Horizontal;
            left.VerticalAlignment = VerticalAlignment.Center;
            left.Margin = new Thickness(16, 0, 0, 0);

            Path puzzleIcon = CreatePath(ICON_PUZZLE, 14, 14, Color.FromRgb(168, 85, 247));
            puzzleIcon.VerticalAlignment = VerticalAlignment.Center;
            left.Children.Add(puzzleIcon);

            TextBlock title = new TextBlock();
            title.Text = "iMCord Installer";
            title.FontSize = 12;
            title.FontWeight = FontWeights.SemiBold;
            title.Foreground = new SolidColorBrush(Color.FromRgb(226, 232, 240));
            title.VerticalAlignment = VerticalAlignment.Center;
            title.Margin = new Thickness(8, 0, 0, 0);
            left.Children.Add(title);

            bar.Children.Add(left);

            // Right window controls
            StackPanel right = new StackPanel();
            right.Orientation = Orientation.Horizontal;
            right.HorizontalAlignment = HorizontalAlignment.Right;
            right.VerticalAlignment = VerticalAlignment.Center;
            right.Margin = new Thickness(0, 0, 8, 0);

            Button btnMin = CreateTitleButton("—", false);
            btnMin.Click += delegate { WindowState = WindowState.Minimized; };

            Button btnMax = CreateTitleButton("▢", false);
            btnMax.Click += delegate {
                WindowState = (WindowState == WindowState.Maximized) ? WindowState.Normal : WindowState.Maximized;
            };

            Button btnClose = CreateTitleButton("✕", true);
            btnClose.Click += delegate { Close(); };

            right.Children.Add(btnMin);
            right.Children.Add(btnMax);
            right.Children.Add(btnClose);

            bar.Children.Add(right);

            return bar;
        }

        private Button CreateTitleButton(string text, bool isClose)
        {
            Button btn = new Button();
            btn.Content = text;
            btn.Width = 34;
            btn.Height = 28;
            btn.FontSize = 11;
            btn.Foreground = new SolidColorBrush(Color.FromRgb(139, 136, 165));
            btn.Cursor = Cursors.Hand;

            ControlTemplate template = new ControlTemplate(typeof(Button));
            FrameworkElementFactory border = new FrameworkElementFactory(typeof(Border));
            border.Name = "btnBorder";
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(6));
            border.SetValue(Border.BackgroundProperty, Brushes.Transparent);

            FrameworkElementFactory content = new FrameworkElementFactory(typeof(ContentPresenter));
            content.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            content.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            border.AppendChild(content);

            Trigger hover = new Trigger() { Property = Button.IsMouseOverProperty, Value = true };
            hover.Setters.Add(new Setter(Border.BackgroundProperty, new SolidColorBrush(isClose ? Color.FromRgb(220, 38, 38) : Color.FromRgb(36, 31, 56)), "btnBorder"));
            hover.Setters.Add(new Setter(Button.ForegroundProperty, Brushes.White));

            template.VisualTree = border;
            template.Triggers.Add(hover);
            btn.Template = template;

            return btn;
        }

        private Border BuildSidebar()
        {
            Border sidebar = new Border();
            sidebar.Background = Brushes.Transparent;
            sidebar.BorderThickness = new Thickness(0);

            Grid stack = new Grid();
            stack.RowDefinitions.Add(new RowDefinition() { Height = new GridLength(270) });
            stack.RowDefinitions.Add(new RowDefinition() { Height = GridLength.Auto });
            stack.RowDefinitions.Add(new RowDefinition() { Height = new GridLength(1, GridUnitType.Star) });

            // 1. Artwork Canvas (Floating glowing 3D puzzle + orbs + orbital rings)
            Canvas art = new Canvas();
            art.Width = 260;
            art.Height = 270;
            art.ClipToBounds = true;

            // Ambient radial glow
            Ellipse glow = new Ellipse() { Width = 230, Height = 230 };
            RadialGradientBrush glowBrush = new RadialGradientBrush();
            glowBrush.GradientStops.Add(new GradientStop(Color.FromArgb(90, 147, 51, 234), 0.0));
            glowBrush.GradientStops.Add(new GradientStop(Color.FromArgb(0, 124, 58, 237), 1.0));
            glow.Fill = glowBrush;
            Canvas.SetLeft(glow, 15);
            Canvas.SetTop(glow, 25);
            art.Children.Add(glow);

            // Orbiting glow ring
            Ellipse ring = new Ellipse() { Width = 220, Height = 75 };
            ring.Stroke = new SolidColorBrush(Color.FromArgb(90, 168, 85, 247));
            ring.StrokeThickness = 1.5;
            ring.RenderTransform = new RotateTransform(-25, 110, 37.5);
            Canvas.SetLeft(ring, 20);
            Canvas.SetTop(ring, 95);
            art.Children.Add(ring);

            // Floating spheres
            Ellipse orb1 = new Ellipse() { Width = 24, Height = 24 };
            RadialGradientBrush orbBrush1 = new RadialGradientBrush();
            orbBrush1.Center = new Point(0.35, 0.35);
            orbBrush1.GradientStops.Add(new GradientStop(Color.FromRgb(216, 180, 254), 0.0));
            orbBrush1.GradientStops.Add(new GradientStop(Color.FromRgb(147, 51, 234), 0.6));
            orbBrush1.GradientStops.Add(new GradientStop(Color.FromRgb(59, 7, 100), 1.0));
            orb1.Fill = orbBrush1;
            Canvas.SetLeft(orb1, 35);
            Canvas.SetTop(orb1, 55);
            art.Children.Add(orb1);

            Ellipse orb2 = new Ellipse() { Width = 16, Height = 16 };
            RadialGradientBrush orbBrush2 = new RadialGradientBrush();
            orbBrush2.Center = new Point(0.35, 0.35);
            orbBrush2.GradientStops.Add(new GradientStop(Color.FromRgb(192, 132, 252), 0.0));
            orbBrush2.GradientStops.Add(new GradientStop(Color.FromRgb(126, 34, 206), 0.7));
            orbBrush2.GradientStops.Add(new GradientStop(Color.FromRgb(30, 4, 52), 1.0));
            orb2.Fill = orbBrush2;
            Canvas.SetLeft(orb2, 195);
            Canvas.SetTop(orb2, 140);
            art.Children.Add(orb2);

            // Centerpiece Puzzle piece (3D glass styled)
            Viewbox puzzleBox = new Viewbox() { Width = 110, Height = 110 };
            Path puzzlePath = new Path();
            puzzlePath.Data = Geometry.Parse(ICON_PUZZLE);

            LinearGradientBrush puzzleGrad = new LinearGradientBrush();
            puzzleGrad.StartPoint = new Point(0, 0);
            puzzleGrad.EndPoint = new Point(1, 1);
            puzzleGrad.GradientStops.Add(new GradientStop(Color.FromRgb(192, 132, 252), 0.0)); // Light violet
            puzzleGrad.GradientStops.Add(new GradientStop(Color.FromRgb(147, 51, 234), 0.45));
            puzzleGrad.GradientStops.Add(new GradientStop(Color.FromRgb(88, 28, 135), 1.0));
            puzzlePath.Fill = puzzleGrad;

            puzzlePath.Effect = new DropShadowEffect()
            {
                BlurRadius = 24,
                ShadowDepth = 4,
                Color = Color.FromRgb(168, 85, 247),
                Opacity = 0.7
            };
            puzzleBox.Child = puzzlePath;

            Canvas.SetLeft(puzzleBox, 75);
            Canvas.SetTop(glow, 50);
            Canvas.SetTop(puzzleBox, 65);
            art.Children.Add(puzzleBox);

            Grid.SetRow(art, 0);
            stack.Children.Add(art);

            // 2. Middle Text Block
            StackPanel textStack = new StackPanel();
            textStack.HorizontalAlignment = HorizontalAlignment.Center;
            textStack.Margin = new Thickness(0, 0, 0, 0);

            StackPanel titleRow = new StackPanel();
            titleRow.Orientation = Orientation.Horizontal;
            titleRow.HorizontalAlignment = HorizontalAlignment.Center;

            TextBlock tbVencord = new TextBlock() { Text = "iMCord", FontSize = 24, FontWeight = FontWeights.Bold, Foreground = Brushes.White };
            TextBlock tbInstaller = new TextBlock() { Text = " Installer", FontSize = 24, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(Color.FromRgb(168, 85, 247)) };
            titleRow.Children.Add(tbVencord);
            titleRow.Children.Add(tbInstaller);
            textStack.Children.Add(titleRow);

            TextBlock tbCustom = new TextBlock()
            {
                Text = "Custom Discord.",
                FontSize = 13,
                Foreground = new SolidColorBrush(Color.FromRgb(138, 134, 166)),
                FontWeight = FontWeights.Medium,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 10, 0, 0)
            };
            TextBlock tbYourWay = new TextBlock()
            {
                Text = "Your way.",
                FontSize = 13,
                Foreground = new SolidColorBrush(Color.FromRgb(138, 134, 166)),
                FontWeight = FontWeights.Medium,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 2, 0, 0)
            };
            textStack.Children.Add(tbCustom);
            textStack.Children.Add(tbYourWay);

            Grid.SetRow(textStack, 1);
            stack.Children.Add(textStack);

            // 3. Bottom ambient wave curve
            Canvas waveCanvas = new Canvas() { ClipToBounds = true };
            Path wave = new Path();
            wave.Data = Geometry.Parse("M 0 100 C 60 70, 140 120, 260 40 L 260 160 L 0 160 Z");
            LinearGradientBrush waveBrush = new LinearGradientBrush();
            waveBrush.StartPoint = new Point(0, 0);
            waveBrush.EndPoint = new Point(1, 1);
            waveBrush.GradientStops.Add(new GradientStop(Color.FromArgb(60, 124, 58, 237), 0.0));
            waveBrush.GradientStops.Add(new GradientStop(Color.FromArgb(10, 76, 29, 149), 1.0));
            wave.Fill = waveBrush;
            waveCanvas.Children.Add(wave);

            Grid.SetRow(waveCanvas, 2);
            stack.Children.Add(waveCanvas);

            sidebar.Child = stack;
            return sidebar;
        }

        private Border BuildContentArea()
        {
            Border card = new Border();
            card.Background = new SolidColorBrush(Color.FromRgb(17, 15, 29)); // #110F1D
            card.BorderBrush = new SolidColorBrush(Color.FromRgb(32, 28, 52)); // #201C34
            card.BorderThickness = new Thickness(1);
            card.CornerRadius = new CornerRadius(18);
            card.Margin = new Thickness(0, 8, 24, 14);
            card.Padding = new Thickness(26, 22, 26, 22);

            Grid content = new Grid();
            content.RowDefinitions.Add(new RowDefinition() { Height = GridLength.Auto }); // Header Row
            content.RowDefinitions.Add(new RowDefinition() { Height = new GridLength(1, GridUnitType.Star) }); // Discord Card
            content.RowDefinitions.Add(new RowDefinition() { Height = GridLength.Auto }); // Status Banner

            // 1. Top Header Row
            Grid headerGrid = new Grid();

            StackPanel titleStack = new StackPanel();
            StackPanel mainTitle = new StackPanel() { Orientation = Orientation.Horizontal };
            mainTitle.Children.Add(new TextBlock() { Text = "iMCord ", FontSize = 28, FontWeight = FontWeights.ExtraBold, Foreground = Brushes.White });
            mainTitle.Children.Add(new TextBlock() { Text = "Installer", FontSize = 28, FontWeight = FontWeights.ExtraBold, Foreground = new SolidColorBrush(Color.FromRgb(168, 85, 247)) });
            titleStack.Children.Add(mainTitle);

            TextBlock subTitle = new TextBlock()
            {
                Text = "Please select an install to patch",
                FontSize = 14,
                Foreground = new SolidColorBrush(Color.FromRgb(141, 137, 164)),
                Margin = new Thickness(0, 4, 0, 0)
            };
            titleStack.Children.Add(subTitle);
            headerGrid.Children.Add(titleStack);

            // Safe & Open Source badge
            Border badge = new Border()
            {
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Top,
                CornerRadius = new CornerRadius(16),
                Background = new SolidColorBrush(Color.FromRgb(26, 24, 43)),
                BorderBrush = new SolidColorBrush(Color.FromRgb(49, 41, 74)),
                BorderThickness = new Thickness(1),
                Padding = new Thickness(12, 6, 14, 6)
            };
            StackPanel badgeStack = new StackPanel() { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            Path shield = CreatePath(ICON_SHIELD, 14, 14, Color.FromRgb(157, 150, 184));
            badgeStack.Children.Add(shield);
            badgeStack.Children.Add(new TextBlock()
            {
                Text = "Safe & Open Source",
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(Color.FromRgb(157, 150, 184)),
                Margin = new Thickness(7, 0, 0, 0)
            });
            badge.Child = badgeStack;
            headerGrid.Children.Add(badge);

            Grid.SetRow(headerGrid, 0);
            content.Children.Add(headerGrid);

            // 2. Main Discord Accordion Card
            Border cardBorder = new Border()
            {
                Background = new SolidColorBrush(Color.FromRgb(21, 20, 36)), // #151424
                BorderBrush = new SolidColorBrush(Color.FromRgb(42, 37, 66)), // #2a2542
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(16),
                Margin = new Thickness(0, 18, 0, 0),
                Padding = new Thickness(18, 16, 18, 18)
            };

            StackPanel cardStack = new StackPanel();

            // Header Row
            Grid accHeader = new Grid();
            accHeader.ColumnDefinitions.Add(new ColumnDefinition() { Width = GridLength.Auto });
            accHeader.ColumnDefinitions.Add(new ColumnDefinition() { Width = new GridLength(1, GridUnitType.Star) });

            // Discord icon in circle
            Border discordCircle = new Border()
            {
                Width = 42,
                Height = 42,
                CornerRadius = new CornerRadius(21),
                Background = new SolidColorBrush(Color.FromRgb(88, 101, 242)) // #5865F2
            };
            Path discordSvg = CreatePath(ICON_DISCORD, 22, 22, Colors.White);
            discordCircle.Child = discordSvg;
            Grid.SetColumn(discordCircle, 0);
            accHeader.Children.Add(discordCircle);

            StackPanel headerText = new StackPanel() { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(14, 0, 0, 0) };
            headerText.Children.Add(new TextBlock() { Text = "Discord", FontSize = 16, FontWeight = FontWeights.Bold, Foreground = Brushes.White });
            headerText.Children.Add(new TextBlock() { Text = "Select the Discord installation to patch.", FontSize = 12, Foreground = new SolidColorBrush(Color.FromRgb(130, 126, 153)), Margin = new Thickness(0, 2, 0, 0) });
            Grid.SetColumn(headerText, 1);
            accHeader.Children.Add(headerText);

            cardStack.Children.Add(accHeader);

            // Discord Section Content
            StackPanel cardBody = new StackPanel();

            // Selected Discord Item Box
            _selectedCardBorder = new Border()
            {
                Background = new SolidColorBrush(Color.FromRgb(28, 24, 51)), // #1c1833
                BorderBrush = new SolidColorBrush(Color.FromRgb(79, 61, 130)), // #4f3d82
                BorderThickness = new Thickness(1.5),
                CornerRadius = new CornerRadius(12),
                Padding = new Thickness(14, 12, 14, 12),
                Margin = new Thickness(0, 16, 0, 14),
                Cursor = Cursors.Hand
            };

            Grid itemGrid = new Grid();
            itemGrid.ColumnDefinitions.Add(new ColumnDefinition() { Width = GridLength.Auto });
            itemGrid.ColumnDefinitions.Add(new ColumnDefinition() { Width = GridLength.Auto });
            itemGrid.ColumnDefinitions.Add(new ColumnDefinition() { Width = new GridLength(1, GridUnitType.Star) });

            // Glowing Radio Dot
            _radioOuter = new Border()
            {
                Width = 20,
                Height = 20,
                CornerRadius = new CornerRadius(10),
                Background = new SolidColorBrush(Color.FromRgb(41, 32, 70)),
                BorderBrush = new SolidColorBrush(Color.FromRgb(168, 85, 247)),
                BorderThickness = new Thickness(2),
                VerticalAlignment = VerticalAlignment.Center
            };
            _radioInner = new Border()
            {
                Width = 8,
                Height = 8,
                CornerRadius = new CornerRadius(4),
                Background = new SolidColorBrush(Color.FromRgb(168, 85, 247)),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            _radioOuter.Child = _radioInner;
            Grid.SetColumn(_radioOuter, 0);
            itemGrid.Children.Add(_radioOuter);

            // Discord squircle icon
            Border appIconBorder = new Border()
            {
                Width = 34,
                Height = 34,
                CornerRadius = new CornerRadius(8),
                Background = new SolidColorBrush(Color.FromRgb(88, 101, 242)),
                Margin = new Thickness(12, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center
            };
            appIconBorder.Child = CreatePath(ICON_DISCORD, 18, 18, Colors.White);
            Grid.SetColumn(appIconBorder, 1);
            itemGrid.Children.Add(appIconBorder);

            StackPanel pathStack = new StackPanel() { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12, 0, 0, 0) };
            _selectedCardTitle = new TextBlock() { Text = "iMCord Installed", FontSize = 13.5, FontWeight = FontWeights.Bold, Foreground = Brushes.White };
            _selectedCardPath = new TextBlock() { Text = "C:\\Users\\iMA\\AppData\\Local\\Discord", FontSize = 11.5, Foreground = new SolidColorBrush(Color.FromRgb(126, 123, 150)), Margin = new Thickness(0, 2, 0, 0) };
            pathStack.Children.Add(_selectedCardTitle);
            pathStack.Children.Add(_selectedCardPath);
            Grid.SetColumn(pathStack, 2);
            itemGrid.Children.Add(pathStack);

            _selectedCardBorder.Child = itemGrid;
            _selectedCardBorder.MouseDown += delegate { SwitchNextDiscord(); };
            cardBody.Children.Add(_selectedCardBorder);

            // Custom Install Location section
            StackPanel customHeader = new StackPanel() { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 2, 0, 8) };
            Path pinIcon = CreatePath(ICON_PIN, 16, 16, Color.FromRgb(155, 148, 181));
            customHeader.Children.Add(pinIcon);
            customHeader.Children.Add(new TextBlock()
            {
                Text = "Custom Install Location",
                FontSize = 13,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(Color.FromRgb(155, 148, 181)),
                Margin = new Thickness(8, 0, 0, 0)
            });
            cardBody.Children.Add(customHeader);

            Grid customRow = new Grid();
            customRow.ColumnDefinitions.Add(new ColumnDefinition() { Width = new GridLength(1, GridUnitType.Star) });
            customRow.ColumnDefinitions.Add(new ColumnDefinition() { Width = new GridLength(10) });
            customRow.ColumnDefinitions.Add(new ColumnDefinition() { Width = new GridLength(120) });

            // Pill-shaped Border container for TextBox
            Border pathBoxBorder = new Border()
            {
                Height = 40,
                CornerRadius = new CornerRadius(20),
                Background = new SolidColorBrush(Color.FromRgb(17, 16, 30)),
                BorderBrush = new SolidColorBrush(Color.FromRgb(38, 33, 58)),
                BorderThickness = new Thickness(1),
                Padding = new Thickness(16, 0, 16, 0),
                VerticalAlignment = VerticalAlignment.Center
            };

            _customPathBox = new TextBox();
            _customPathBox.Height = 36;
            _customPathBox.FontSize = 13;
            _customPathBox.Background = Brushes.Transparent;
            _customPathBox.Foreground = new SolidColorBrush(Color.FromRgb(200, 196, 222));
            _customPathBox.BorderThickness = new Thickness(0);
            _customPathBox.VerticalContentAlignment = VerticalAlignment.Center;
            _customPathBox.TextChanged += delegate {
                if (!string.IsNullOrEmpty(_customPathBox.Text) && Directory.Exists(_customPathBox.Text))
                {
                    _selectedDiscord = InstallerCore.ParseDiscord(_customPathBox.Text);
                    UpdateUi();
                }
            };
            pathBoxBorder.Child = _customPathBox;
            Grid.SetColumn(pathBoxBorder, 0);
            customRow.Children.Add(pathBoxBorder);

            _btnBrowse = CreateStyledPillButton("Browse...", ICON_FOLDER, Color.FromRgb(30, 28, 49), Color.FromRgb(40, 36, 66), Color.FromRgb(49, 44, 76), Color.FromRgb(209, 204, 232));
            _btnBrowse.Height = 40;
            _btnBrowse.Click += delegate {
                using (var fbd = new System.Windows.Forms.FolderBrowserDialog())
                {
                    fbd.Description = "Select Discord Directory (containing app-* folder)";
                    if (fbd.ShowDialog() == System.Windows.Forms.DialogResult.OK)
                    {
                        _customPathBox.Text = fbd.SelectedPath;
                    }
                }
            };
            Grid.SetColumn(_btnBrowse, 2);
            customRow.Children.Add(_btnBrowse);

            cardBody.Children.Add(customRow);
            cardStack.Children.Add(cardBody);
            cardBorder.Child = cardStack;

            Grid.SetRow(cardBorder, 1);
            content.Children.Add(cardBorder);

            // 3. Status Banner
            _statusBanner = new Border()
            {
                Background = new SolidColorBrush(Color.FromRgb(20, 19, 35)),
                BorderBrush = new SolidColorBrush(Color.FromRgb(35, 32, 56)),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(10),
                Padding = new Thickness(14, 10, 14, 10),
                Margin = new Thickness(0, 14, 0, 14)
            };
            StackPanel statusStack = new StackPanel() { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            _statusIcon = CreatePath(ICON_INFO, 16, 16, Color.FromRgb(141, 137, 164));
            statusStack.Children.Add(_statusIcon);

            _statusText = new TextBlock()
            {
                Text = "Selected: C:\\Users\\iMA\\AppData\\Local\\Discord (iMCord is active)",
                FontSize = 12,
                Foreground = new SolidColorBrush(Color.FromRgb(141, 137, 164)),
                Margin = new Thickness(8, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center
            };
            statusStack.Children.Add(_statusText);
            _statusBanner.Child = statusStack;

            Grid.SetRow(_statusBanner, 2);
            content.Children.Add(_statusBanner);

            card.Child = content;
            return card;
        }

        private Grid BuildActionBar()
        {
            Grid actionGrid = new Grid();
            actionGrid.Margin = new Thickness(24, 0, 24, 18);
            actionGrid.ColumnDefinitions.Add(new ColumnDefinition() { Width = new GridLength(260) });
            actionGrid.ColumnDefinitions.Add(new ColumnDefinition() { Width = new GridLength(1, GridUnitType.Star) });

            // Left Settings Button
            // Left Folder Button (opens plugins path)
            _btnSettings = CreateIconButton(ICON_FOLDER, Color.FromRgb(27, 25, 46), Color.FromRgb(38, 34, 62), Color.FromRgb(46, 41, 72), Color.FromRgb(200, 196, 222));
            _btnSettings.Width = 46;
            _btnSettings.Height = 46;
            _btnSettings.HorizontalAlignment = HorizontalAlignment.Left;
            _btnSettings.ToolTip = "Open iMCord Plugins Directory";
            _btnSettings.Click += delegate {
                try {
                    if (!Directory.Exists(InstallerCore.VencordUserPluginsDir))
                        Directory.CreateDirectory(InstallerCore.VencordUserPluginsDir);
                    Process.Start("explorer.exe", InstallerCore.VencordUserPluginsDir);
                } catch { }
            };
            Grid.SetColumn(_btnSettings, 0);
            actionGrid.Children.Add(_btnSettings);

            // Right Action Buttons Grid (3 equal columns: Install, Repair, Uninstall)
            Grid btnGrid = new Grid();
            btnGrid.ColumnDefinitions.Add(new ColumnDefinition() { Width = new GridLength(1, GridUnitType.Star) });
            btnGrid.ColumnDefinitions.Add(new ColumnDefinition() { Width = new GridLength(1, GridUnitType.Star) });
            btnGrid.ColumnDefinitions.Add(new ColumnDefinition() { Width = new GridLength(1, GridUnitType.Star) });

            // Green Install Button
            _btnInstall = CreateGradientButton("Install", ICON_DOWNLOAD,
                Color.FromRgb(22, 163, 74), Color.FromRgb(34, 197, 94), Color.FromRgb(74, 222, 128),
                Color.FromRgb(21, 128, 61), Color.FromRgb(22, 163, 74), Colors.White);
            _btnInstall.Effect = new DropShadowEffect()
            {
                BlurRadius = 18,
                ShadowDepth = 0,
                Opacity = 0.55,
                Color = Color.FromRgb(34, 197, 94)
            };

            // Purple Reinstall / Repair Button
            _btnRepair = CreateGradientButton("Reinstall / Repair", ICON_WRENCH,
                Color.FromRgb(109, 40, 217), Color.FromRgb(139, 92, 246), Color.FromRgb(147, 51, 234),
                Color.FromRgb(124, 58, 237), Color.FromRgb(168, 85, 247), Colors.White);
            _btnRepair.Effect = new DropShadowEffect()
            {
                BlurRadius = 18,
                ShadowDepth = 0,
                Opacity = 0.55,
                Color = Color.FromRgb(147, 51, 234)
            };

            // Crimson / Wine Uninstall Button
            _btnUninstall = CreateGradientButton("Uninstall", ICON_TRASH,
                Color.FromRgb(74, 21, 37), Color.FromRgb(127, 29, 43), Color.FromRgb(153, 27, 27),
                Color.FromRgb(95, 27, 47), Color.FromRgb(159, 29, 45), Color.FromRgb(254, 205, 211));

            _btnInstall.Margin = new Thickness(0, 0, 6, 0);
            _btnRepair.Margin = new Thickness(6, 0, 6, 0);
            _btnUninstall.Margin = new Thickness(6, 0, 0, 0);

            _btnInstall.Click += delegate { ExecuteAction(ActionType.Install); };
            _btnRepair.Click += delegate { ExecuteAction(ActionType.Repair); };
            _btnUninstall.Click += delegate { ExecuteAction(ActionType.Uninstall); };

            Grid.SetColumn(_btnInstall, 0);
            Grid.SetColumn(_btnRepair, 1);
            Grid.SetColumn(_btnUninstall, 2);

            btnGrid.Children.Add(_btnInstall);
            btnGrid.Children.Add(_btnRepair);
            btnGrid.Children.Add(_btnUninstall);

            Grid.SetColumn(btnGrid, 1);
            actionGrid.Children.Add(btnGrid);

            return actionGrid;
        }

        private void SwitchNextDiscord()
        {
            if (_discords == null || _discords.Count == 0) return;
            int idx = _discords.IndexOf(_selectedDiscord);
            int nextIdx = (idx + 1) % _discords.Count;
            _selectedDiscord = _discords[nextIdx];
            UpdateUi();
        }

        private void RefreshDiscords()
        {
            _discords = InstallerCore.FindDiscords();
            if (_discords.Count > 0)
            {
                _selectedDiscord = _discords[0];
            }
            else
            {
                string defaultPath = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Discord");
                _selectedDiscord = InstallerCore.ParseDiscord(defaultPath);
            }
            UpdateUi();
        }

        private void UpdateUi()
        {
            if (_selectedDiscord == null)
            {
                _selectedCardTitle.Text = "No Discord Selected";
                _selectedCardPath.Text = "Please browse for a valid Discord installation";
                _customPathBox.Text = "";
                SetStatus("Please select or browse for a valid Discord installation.", StatusLevel.Info);
                _btnInstall.IsEnabled = false;
                _btnRepair.IsEnabled = false;
                _btnUninstall.IsEnabled = false;
                return;
            }

            _selectedCardTitle.Text = _selectedDiscord.IsPatched ? "iMCord Installed" : _selectedDiscord.Name;
            _selectedCardPath.Text = _selectedDiscord.BasePath;
            _customPathBox.Text = _selectedDiscord.BasePath;

            _btnInstall.IsEnabled = true;
            _btnRepair.IsEnabled = true;
            _btnUninstall.IsEnabled = _selectedDiscord.IsPatched;

            SetStatus("Selected: " + _selectedDiscord.BasePath + (_selectedDiscord.IsPatched ? " (iMCord is active)" : ""), StatusLevel.Info);
        }

        private Path CreatePath(string data, double width, double height, Color fill)
        {
            Path p = new Path();
            p.Data = Geometry.Parse(data);
            p.Fill = new SolidColorBrush(fill);
            p.Width = width;
            p.Height = height;
            p.Stretch = Stretch.Uniform;
            return p;
        }

        private Button CreateStyledPillButton(string text, string iconData, Color bg, Color hoverBg, Color borderCol, Color fg)
        {
            Button btn = new Button();
            btn.Height = 40;
            btn.Cursor = Cursors.Hand;

            StackPanel pnl = new StackPanel() { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
            if (!string.IsNullOrEmpty(iconData))
            {
                Path icon = CreatePath(iconData, 16, 16, fg);
                icon.VerticalAlignment = VerticalAlignment.Center;
                pnl.Children.Add(icon);
            }

            TextBlock tb = new TextBlock()
            {
                Text = text,
                FontSize = 13,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(fg),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(8, 0, 0, 0)
            };
            pnl.Children.Add(tb);

            ControlTemplate template = new ControlTemplate(typeof(Button));
            FrameworkElementFactory border = new FrameworkElementFactory(typeof(Border));
            border.Name = "btnBorder";
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(20));
            border.SetValue(Border.BackgroundProperty, new SolidColorBrush(bg));
            border.SetValue(Border.BorderBrushProperty, new SolidColorBrush(borderCol));
            border.SetValue(Border.BorderThicknessProperty, new Thickness(1));

            FrameworkElementFactory content = new FrameworkElementFactory(typeof(ContentPresenter));
            content.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            content.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            border.AppendChild(content);

            Trigger hover = new Trigger() { Property = Button.IsMouseOverProperty, Value = true };
            hover.Setters.Add(new Setter(Border.BackgroundProperty, new SolidColorBrush(hoverBg), "btnBorder"));

            Trigger pressed = new Trigger() { Property = Button.IsPressedProperty, Value = true };
            pressed.Setters.Add(new Setter(Border.OpacityProperty, 0.85, "btnBorder"));

            Trigger disabled = new Trigger() { Property = Button.IsEnabledProperty, Value = false };
            disabled.Setters.Add(new Setter(Border.OpacityProperty, 0.4, "btnBorder"));

            template.VisualTree = border;
            template.Triggers.Add(hover);
            template.Triggers.Add(pressed);
            template.Triggers.Add(disabled);

            btn.Template = template;
            btn.Content = pnl;
            return btn;
        }

        private Button CreateGradientButton(string text, string iconData, Color gradStart, Color gradEnd, Color borderCol, Color hoverStart, Color hoverEnd, Color fg)
        {
            Button btn = new Button();
            btn.Height = 44;
            btn.Padding = new Thickness(18, 0, 18, 0);
            btn.Cursor = Cursors.Hand;

            StackPanel pnl = new StackPanel() { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
            if (!string.IsNullOrEmpty(iconData))
            {
                Path icon = CreatePath(iconData, 16, 16, fg);
                icon.VerticalAlignment = VerticalAlignment.Center;
                pnl.Children.Add(icon);
            }

            TextBlock tb = new TextBlock()
            {
                Text = text,
                FontSize = 13.5,
                FontWeight = FontWeights.Bold,
                Foreground = new SolidColorBrush(fg),
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(8, 0, 0, 0)
            };
            pnl.Children.Add(tb);

            LinearGradientBrush normalBrush = new LinearGradientBrush();
            normalBrush.StartPoint = new Point(0, 0);
            normalBrush.EndPoint = new Point(1, 1);
            normalBrush.GradientStops.Add(new GradientStop(gradStart, 0.0));
            normalBrush.GradientStops.Add(new GradientStop(gradEnd, 1.0));

            LinearGradientBrush hoverBrush = new LinearGradientBrush();
            hoverBrush.StartPoint = new Point(0, 0);
            hoverBrush.EndPoint = new Point(1, 1);
            hoverBrush.GradientStops.Add(new GradientStop(hoverStart, 0.0));
            hoverBrush.GradientStops.Add(new GradientStop(hoverEnd, 1.0));

            ControlTemplate template = new ControlTemplate(typeof(Button));
            FrameworkElementFactory border = new FrameworkElementFactory(typeof(Border));
            border.Name = "btnBorder";
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(12));
            border.SetValue(Border.BackgroundProperty, normalBrush);
            border.SetValue(Border.BorderBrushProperty, new SolidColorBrush(borderCol));
            border.SetValue(Border.BorderThicknessProperty, new Thickness(1));

            FrameworkElementFactory content = new FrameworkElementFactory(typeof(ContentPresenter));
            content.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            content.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            border.AppendChild(content);

            Trigger hover = new Trigger() { Property = Button.IsMouseOverProperty, Value = true };
            hover.Setters.Add(new Setter(Border.BackgroundProperty, hoverBrush, "btnBorder"));

            Trigger pressed = new Trigger() { Property = Button.IsPressedProperty, Value = true };
            pressed.Setters.Add(new Setter(Border.OpacityProperty, 0.85, "btnBorder"));

            Trigger disabled = new Trigger() { Property = Button.IsEnabledProperty, Value = false };
            disabled.Setters.Add(new Setter(Border.OpacityProperty, 0.35, "btnBorder"));

            template.VisualTree = border;
            template.Triggers.Add(hover);
            template.Triggers.Add(pressed);
            template.Triggers.Add(disabled);

            btn.Template = template;
            btn.Content = pnl;
            return btn;
        }

        private Button CreateIconButton(string iconData, Color bg, Color hoverBg, Color borderCol, Color fg)
        {
            Button btn = new Button();
            btn.Cursor = Cursors.Hand;

            Path icon = CreatePath(iconData, 20, 20, fg);
            icon.HorizontalAlignment = HorizontalAlignment.Center;
            icon.VerticalAlignment = VerticalAlignment.Center;

            ControlTemplate template = new ControlTemplate(typeof(Button));
            FrameworkElementFactory border = new FrameworkElementFactory(typeof(Border));
            border.Name = "btnBorder";
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(12));
            border.SetValue(Border.BackgroundProperty, new SolidColorBrush(bg));
            border.SetValue(Border.BorderBrushProperty, new SolidColorBrush(borderCol));
            border.SetValue(Border.BorderThicknessProperty, new Thickness(1));

            FrameworkElementFactory content = new FrameworkElementFactory(typeof(ContentPresenter));
            content.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            content.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            border.AppendChild(content);

            Trigger hover = new Trigger() { Property = Button.IsMouseOverProperty, Value = true };
            hover.Setters.Add(new Setter(Border.BackgroundProperty, new SolidColorBrush(hoverBg), "btnBorder"));

            template.VisualTree = border;
            template.Triggers.Add(hover);

            btn.Template = template;
            btn.Content = icon;
            return btn;
        }

        private enum StatusLevel
        {
            Info,
            Success,
            Error
        }

        private void SetStatus(string message, StatusLevel level = StatusLevel.Info)
        {
            if (_statusText == null || _statusBanner == null || _statusIcon == null) return;

            Dispatcher.Invoke(new Action(delegate {
                _statusText.Text = message;
                if (level == StatusLevel.Success)
                {
                    _statusBanner.Background = new SolidColorBrush(Color.FromArgb(45, 22, 163, 74));
                    _statusBanner.BorderBrush = new SolidColorBrush(Color.FromRgb(34, 197, 94));
                    _statusIcon.Data = Geometry.Parse("M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z");
                    _statusIcon.Fill = new SolidColorBrush(Color.FromRgb(74, 222, 128));
                    _statusText.Foreground = new SolidColorBrush(Color.FromRgb(220, 252, 231));
                    _statusText.FontWeight = FontWeights.SemiBold;
                }
                else if (level == StatusLevel.Error)
                {
                    _statusBanner.Background = new SolidColorBrush(Color.FromArgb(45, 220, 38, 38));
                    _statusBanner.BorderBrush = new SolidColorBrush(Color.FromRgb(239, 68, 68));
                    _statusIcon.Data = Geometry.Parse("M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z");
                    _statusIcon.Fill = new SolidColorBrush(Color.FromRgb(248, 113, 113));
                    _statusText.Foreground = new SolidColorBrush(Color.FromRgb(254, 226, 226));
                    _statusText.FontWeight = FontWeights.SemiBold;
                }
                else
                {
                    _statusBanner.Background = new SolidColorBrush(Color.FromRgb(20, 19, 35));
                    _statusBanner.BorderBrush = new SolidColorBrush(Color.FromRgb(35, 32, 56));
                    _statusIcon.Data = Geometry.Parse(ICON_INFO);
                    _statusIcon.Fill = new SolidColorBrush(Color.FromRgb(141, 137, 164));
                    _statusText.Foreground = new SolidColorBrush(Color.FromRgb(141, 137, 164));
                    _statusText.FontWeight = FontWeights.Normal;
                }
            }));
        }

        private Grid BuildFeedbackOverlay()
        {
            Grid overlay = new Grid();
            overlay.Background = new SolidColorBrush(Color.FromArgb(195, 10, 8, 20));
            overlay.Visibility = Visibility.Collapsed;
            overlay.Opacity = 0.0;
            overlay.HorizontalAlignment = HorizontalAlignment.Stretch;
            overlay.VerticalAlignment = VerticalAlignment.Stretch;

            Border card = new Border();
            card.Background = new SolidColorBrush(Color.FromRgb(18, 15, 33));
            card.BorderBrush = new SolidColorBrush(Color.FromRgb(34, 197, 94));
            card.BorderThickness = new Thickness(1.5);
            card.CornerRadius = new CornerRadius(20);
            card.Padding = new Thickness(40, 30, 40, 30);
            card.HorizontalAlignment = HorizontalAlignment.Center;
            card.VerticalAlignment = VerticalAlignment.Center;
            card.Effect = new DropShadowEffect()
            {
                BlurRadius = 36,
                ShadowDepth = 0,
                Opacity = 0.7,
                Color = Color.FromRgb(34, 197, 94)
            };

            StackPanel stack = new StackPanel();
            stack.HorizontalAlignment = HorizontalAlignment.Center;
            stack.VerticalAlignment = VerticalAlignment.Center;

            Border iconCircle = new Border();
            iconCircle.Width = 64;
            iconCircle.Height = 64;
            iconCircle.CornerRadius = new CornerRadius(32);
            iconCircle.Background = new SolidColorBrush(Color.FromArgb(50, 34, 197, 94));
            iconCircle.BorderBrush = new SolidColorBrush(Color.FromRgb(74, 222, 128));
            iconCircle.BorderThickness = new Thickness(2);
            iconCircle.HorizontalAlignment = HorizontalAlignment.Center;
            iconCircle.Effect = new DropShadowEffect()
            {
                BlurRadius = 24,
                ShadowDepth = 0,
                Opacity = 0.8,
                Color = Color.FromRgb(74, 222, 128)
            };

            _feedbackIcon = CreatePath("M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z", 30, 30, Color.FromRgb(74, 222, 128));
            _feedbackIcon.HorizontalAlignment = HorizontalAlignment.Center;
            _feedbackIcon.VerticalAlignment = VerticalAlignment.Center;
            iconCircle.Child = _feedbackIcon;
            stack.Children.Add(iconCircle);

            _feedbackTitle = new TextBlock();
            _feedbackTitle.Text = "Patched Successfully!";
            _feedbackTitle.FontSize = 22;
            _feedbackTitle.FontWeight = FontWeights.Bold;
            _feedbackTitle.Foreground = new SolidColorBrush(Color.FromRgb(74, 222, 128));
            _feedbackTitle.TextAlignment = TextAlignment.Center;
            _feedbackTitle.Margin = new Thickness(0, 16, 0, 6);
            _feedbackTitle.Effect = new DropShadowEffect()
            {
                BlurRadius = 14,
                ShadowDepth = 0,
                Opacity = 0.65,
                Color = Color.FromRgb(34, 197, 94)
            };
            stack.Children.Add(_feedbackTitle);

            _feedbackSubtitle = new TextBlock();
            _feedbackSubtitle.Text = "iMCord & plugins patched. Ready to launch Discord.";
            _feedbackSubtitle.FontSize = 13;
            _feedbackSubtitle.Foreground = new SolidColorBrush(Color.FromRgb(200, 240, 215));
            _feedbackSubtitle.TextAlignment = TextAlignment.Center;
            stack.Children.Add(_feedbackSubtitle);

            card.Child = stack;
            overlay.Children.Add(card);

            return overlay;
        }

        private void TriggerFeedbackOverlay(string title, string subtitle, bool isSuccess = true)
        {
            Dispatcher.Invoke(new Action(delegate {
                if (_feedbackTimer != null)
                {
                    _feedbackTimer.Stop();
                    _feedbackTimer = null;
                }

                _feedbackTitle.Text = title;
                _feedbackSubtitle.Text = subtitle;

                Color themeColor = isSuccess ? Color.FromRgb(74, 222, 128) : Color.FromRgb(248, 113, 113);
                _feedbackTitle.Foreground = new SolidColorBrush(themeColor);
                _feedbackIcon.Fill = new SolidColorBrush(themeColor);
                if (!isSuccess)
                {
                    _feedbackIcon.Data = Geometry.Parse("M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z");
                }
                else
                {
                    _feedbackIcon.Data = Geometry.Parse("M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z");
                }

                _mainGrid.Effect = new BlurEffect() { Radius = 14 };

                _feedbackOverlay.Visibility = Visibility.Visible;
                DoubleAnimation fadeIn = new DoubleAnimation(0.0, 1.0, new Duration(TimeSpan.FromMilliseconds(220)));
                _feedbackOverlay.BeginAnimation(UIElement.OpacityProperty, fadeIn);

                _feedbackTimer = new System.Windows.Threading.DispatcherTimer();
                _feedbackTimer.Interval = TimeSpan.FromSeconds(3);
                _feedbackTimer.Tick += delegate {
                    _feedbackTimer.Stop();
                    _feedbackTimer = null;

                    DoubleAnimation fadeOut = new DoubleAnimation(1.0, 0.0, new Duration(TimeSpan.FromMilliseconds(350)));
                    fadeOut.Completed += delegate {
                        _feedbackOverlay.Visibility = Visibility.Collapsed;
                        _mainGrid.Effect = null;
                    };
                    _feedbackOverlay.BeginAnimation(UIElement.OpacityProperty, fadeOut);
                };
                _feedbackTimer.Start();
            }));
        }

        private enum ActionType
        {
            Install,
            Repair,
            Uninstall
        }

        private void ExecuteAction(ActionType action)
        {
            if (_selectedDiscord == null)
            {
                SetStatus("Please select a valid Discord installation first.", StatusLevel.Error);
                return;
            }

            SetBusy(true);

            Action<string> log = delegate(string msg) {
                SetStatus(msg, StatusLevel.Info);
            };

            ThreadPool.QueueUserWorkItem(delegate {
                try
                {
                    switch (action)
                    {
                        case ActionType.Install:
                        case ActionType.Repair:
                            InstallerCore.Install(_selectedDiscord, log);
                            SetStatus("iMCord successfully installed! Custom plugins active. Restart Discord to apply changes.", StatusLevel.Success);
                            Dispatcher.Invoke(new Action(delegate {
                                RefreshDiscords();
                                TriggerFeedbackOverlay("Patched Successfully!", "iMCord & plugins patched. Ready to launch Discord.", true);
                            }));
                            break;

                        case ActionType.Uninstall:
                            InstallerCore.Uninstall(_selectedDiscord, log);
                            SetStatus("iMCord successfully uninstalled. Discord restored to stock.", StatusLevel.Success);
                            Dispatcher.Invoke(new Action(delegate {
                                RefreshDiscords();
                                TriggerFeedbackOverlay("Uninstalled Successfully!", "Discord restored to original stock state.", false);
                            }));
                            break;
                    }
                }
                catch (Exception ex)
                {
                    SetStatus("Action failed: " + ex.Message, StatusLevel.Error);
                    Dispatcher.Invoke(new Action(delegate {
                        TriggerFeedbackOverlay("Action Failed", ex.Message, false);
                    }));
                }
                finally
                {
                    Dispatcher.Invoke(new Action(delegate {
                        SetBusy(false);
                    }));
                }
            });
        }

        private void SetBusy(bool busy)
        {
            _btnInstall.IsEnabled = !busy;
            _btnRepair.IsEnabled = !busy;
            _btnUninstall.IsEnabled = !busy;
        }
    }
}

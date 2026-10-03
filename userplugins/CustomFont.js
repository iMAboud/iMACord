import { definePlugin } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/options";

const FONTS_LIST = [
    // --- خطوط عربية مشهورة ودعم ممتاز ---
    { label: "Tajawal (تجوال - عصري ومريح)", value: "Tajawal" },
    { label: "Cairo (القاهرة - أنيق وواضح)", value: "Cairo" },
    { label: "Almarai (المراعي)", value: "Almarai" },
    { label: "Changa (تشانغا - عريض وحاد)", value: "Changa" },
    { label: "Mada (مدى)", value: "Mada" },
    { label: "Amiri (أميري - كلاسيكي زخرفي)", value: "Amiri" },
    { label: "Traditional Arabic (ويندوز افتراضي)", value: "Traditional Arabic" },
    { label: "Simplified Arabic (ويندوز افتراضي)", value: "Simplified Arabic" },
    { label: "Arabic Typesetting", value: "Arabic Typesetting" },

    // --- خطوط نظام الويندوز الأساسية (Windows System Fonts) ---
    { label: "Segoe UI (خط الويندوز الأساسي)", value: "Segoe UI" },
    { label: "Segoe UI Variable", value: "Segoe UI Variable" },
    { label: "Arial", value: "Arial" },
    { label: "Arial Black", value: "Arial Black" },
    { label: "Calibri", value: "Calibri" },
    { label: "Comic Sans MS (الخط الهزلي 🤪)", value: "Comic Sans MS" },
    { label: "Consolas (خط برمجة 💻)", value: "Consolas" },
    { label: "Courier New", value: "Courier New" },
    { label: "Georgia", value: "Georgia" },
    { label: "Impact (حق الميمز 🎯)", value: "Impact" },
    { label: "Lucida Console", value: "Lucida Console" },
    { label: "MicroSoft Sans Serif", value: "Microsoft Sans Serif" },
    { label: "Segoe Script (خط يدوي)", value: "Segoe Script" },
    { label: "Tahoma", value: "Tahoma" },
    { label: "Times New Roman", value: "Times New Roman" },
    { label: "Trebuchet MS", value: "Trebuchet MS" },
    { label: "Verdana", value: "Verdana" },

    // --- خطوط Google Fonts وإلكترونية عالمية 🌍 ---
    { label: "Inter (الأكثر استخداماً في التطبيقات)", value: "Inter" },
    { label: "Roboto (خط أندرويد الشهير)", value: "Roboto" },
    { label: "Poppins (عصري ودائري)", value: "Poppins" },
    { label: "Montserrat", value: "Montserrat" },
    { label: "Open Sans", value: "Open Sans" },
    { label: "Fira Code (خط برمجيات رهيب)", value: "Fira Code" },
    { label: "JetBrains Mono (جميل جداً)", value: "JetBrains Mono" },

    // --- خيار مخصص ---
    { label: "⚙️ خط مخصص (اكتب الاسم بالخانة السفلية)", value: "CUSTOM" }
];

const settings = definePluginSettings({
    selectedFont: {
        type: OptionType.SELECT,
        description: "اختر الخط من القائمة الشاملة 🎨",
        options: FONTS_LIST,
        default: "Segoe UI",
        onChange: () => applyFont()
    },
    customFontName: {
        type: OptionType.STRING,
        description: "إذا اخترت 'خط مخصص' فوق، اكتب اسمه هنا (مثال: Dubai أو Helvetica):",
        default: "",
        onChange: () => applyFont()
    }
});

function applyFont() {
    let fontToUse = settings.store.selectedFont;
    
    if (fontToUse === "CUSTOM") {
        fontToUse = settings.store.customFontName.trim() || "sans-serif";
    }

    let el = document.getElementById("vencord-custom-font");
    if (!el) {
        el = document.createElement("style");
        el.id = "vencord-custom-font";
        document.head.appendChild(el);
    }

    // استدعاء خطوط Google Fonts تلقائياً لضمان ظهورها حتى لو مو مثبتة بالجهاز
    const googleFonts = ["Tajawal", "Cairo", "Almarai", "Changa", "Mada", "Amiri", "Inter", "Roboto", "Poppins", "Montserrat", "Open Sans", "Fira Code", "JetBrains Mono"];
    let importUrl = "";
    
    if (googleFonts.includes(fontToUse)) {
        const formattedName = fontToUse.replace(/ /g, "+");
        importUrl = `@import url('https://fonts.googleapis.com/css2?family=${formattedName}:wght@400;600;700&display=swap');\n`;
    }

    el.innerHTML = `
        ${importUrl}
        * {
            font-family: '${fontToUse}', 'Segoe UI', Tahoma, sans-serif !important;
        }
    `;
}

export default definePlugin({
    name: "CustomFont",
    description: "تغيير خط ديسكورد مع قائمة ضخمة لأشهر خطوط الويندوز والخطوط العربية والعالمية 🚀",
    authors: [{ name: "MBdr" }],
    settings,
    start() {
        applyFont();
    },
    stop() {
        const el = document.getElementById("vencord-custom-font");
        if (el) el.remove();
    }
});
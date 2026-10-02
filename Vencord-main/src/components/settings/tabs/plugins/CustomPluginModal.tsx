/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2024 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { fetchUserPluginCode, saveAndActivateUserPlugin } from "@api/UserPluginManager";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, showToast, TextInput, Toasts, useRef, useState } from "@webpack/common";

export interface CustomPluginModalProps {
    modalProps: RenderModalProps;
    initialPluginName?: string;
    initialPluginCode?: string;
    isEditing?: boolean;
}

export function CustomPluginModal({ modalProps, initialPluginName = "", initialPluginCode = "", isEditing = false }: CustomPluginModalProps) {
    const [pluginName, setPluginName] = useState(initialPluginName);
    const [pluginCode, setPluginCode] = useState(initialPluginCode);
    const [fileName, setFileName] = useState("");
    const [isSaving, setIsSaving] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    React.useEffect(() => {
        if (isEditing && initialPluginName && !initialPluginCode) {
            fetchUserPluginCode(initialPluginName).then(code => {
                if (code) setPluginCode(code);
            });
        }
    }, [isEditing, initialPluginName, initialPluginCode]);

    const handleSave = async () => {
        if (!pluginName.trim() || !pluginCode.trim()) {
            showToast("Please enter a valid plugin name and code", Toasts.Type.FAILURE);
            return;
        }

        setIsSaving(true);
        try {
            if (VencordNative.userPlugins) {
                const plugin = await saveAndActivateUserPlugin(pluginName.trim(), pluginCode, isEditing ? initialPluginName : undefined);
                showToast(`Saved and ${isEditing ? "updated" : "activated"} plugin "${plugin.name}"!`, Toasts.Type.SUCCESS);
                modalProps.onClose();
            } else {
                showToast("UserPlugins are only supported on Discord Desktop", Toasts.Type.FAILURE);
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            showToast(`Failed to save plugin: ${msg}`, Toasts.Type.FAILURE);
        } finally {
            setIsSaving(false);
        }
    };

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setFileName(file.name);
        const nameWithoutExt = file.name.replace(/\.js$/, "");
        setPluginName(nameWithoutExt);

        const reader = new FileReader();
        reader.onload = event => {
            if (typeof event.target?.result === "string") {
                setPluginCode(event.target.result);
            }
        };
        reader.readAsText(file);
    };

    return (
        <Modal
            {...modalProps}
            title={isEditing ? `Edit Custom Plugin: ${initialPluginName || pluginName}` : "Import / Add Custom Plugin (.js)"}
        >
            <div className="vc-cpm-modal-content">
                <div className="vc-cpm-section">
                    <label className="vc-cpm-label">
                        {isEditing ? "Replace Script from .js File or Edit Below" : "Select .js File or Drag Below"}
                    </label>
                    <label className="vc-cpm-file-drop" onClick={() => fileInputRef.current?.click()}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        <span>{fileName ? `Selected: ${fileName}` : "Click to select or drop .js file"}</span>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".js"
                            onChange={handleFileUpload}
                            style={{ display: "none" }}
                        />
                    </label>
                </div>

                <div className="vc-cpm-section">
                    <label className="vc-cpm-label">Plugin Name</label>
                    <TextInput
                        inputClassName="vc-cpm-input"
                        placeholder="e.g. MyCustomPlugin"
                        value={pluginName}
                        onChange={setPluginName}
                    />
                </div>

                <div className="vc-cpm-section">
                    <label className="vc-cpm-label">Plugin JavaScript Code</label>
                    <textarea
                        className="vc-cpm-textarea"
                        rows={11}
                        value={pluginCode}
                        onChange={e => setPluginCode(e.target.value)}
                        placeholder={"// Paste your Vencord definePlugin code here...\nexport default definePlugin({\n    name: \"MyCustomPlugin\",\n    description: \"My custom plugin\",\n    authors: [{ name: \"Me\", id: 0n }],\n    start() { console.log(\"Custom plugin started!\"); }\n});"}
                    />
                </div>

                <div className="vc-cpm-footer">
                    <button
                        type="button"
                        className="vc-cpm-save-btn"
                        onClick={handleSave}
                        disabled={isSaving || !pluginName || !pluginCode}
                    >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                            <polyline points="17 21 17 13 7 13 7 21" />
                            <polyline points="7 3 7 8 15 8" />
                        </svg>
                        <span>Save Plugin</span>
                    </button>
                    <button
                        type="button"
                        className="vc-cpm-cancel-btn"
                        onClick={modalProps.onClose}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </Modal>
    );
}

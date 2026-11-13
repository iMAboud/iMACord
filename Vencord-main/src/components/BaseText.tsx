/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Text, TextProps, TextSize, TextTag, TextWeight } from "./Text";
export * from "./Text";

// #region Old compability

/** @deprecated use `Text` from `@components/Text` instead */
export const BaseText = Text;
export type BaseTextProps<Tag extends TextTag = "div"> = TextProps<Tag>;

export const TextCompat: any = function TextCompat({ color, variant, ...restProps }: any) {
    const newBaseTextProps = restProps as TextProps;

    if (variant) {
        const [left, right] = String(variant).split("/");
        if (left && right) {
            const size = left.split("-").pop();
            newBaseTextProps.size = size as TextSize;
            newBaseTextProps.weight = right as TextWeight;
        }
    }

    if (color) {
        newBaseTextProps.style ??= {};
        newBaseTextProps.style.color = `var(--${color}, var(--text-default))`;
    }

    return <Text {...newBaseTextProps} />;
};

// #endregion

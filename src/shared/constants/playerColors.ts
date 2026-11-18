export interface ColorSwatch {
  index: number;
  name: string;
  hsl: number;
}

/**
 * Default source HSL colors embedded in OSRS player IdentKit models.
 */
export const DEFAULT_SKIN_SOURCE_HSL = 4550;
export const DEFAULT_HAIR_SOURCE_HSL = 6798;
export const DEFAULT_TORSO_SOURCE_HSL = 8741;

/**
 * Official OSRS skin tones (Makeover Mage / Tutorial Island palette).
 */
export const PLAYER_SKIN_COLORS: ColorSwatch[] = [
  { index: 0, name: 'Fair', hsl: 4550 },
  { index: 1, name: 'Light Tan', hsl: 4537 },
  { index: 2, name: 'Tan', hsl: 5681 },
  { index: 3, name: 'Olive', hsl: 5673 },
  { index: 4, name: 'Light Brown', hsl: 5790 },
  { index: 5, name: 'Brown', hsl: 6806 },
  { index: 6, name: 'Dark Brown', hsl: 8076 },
  { index: 7, name: 'Deep Brown', hsl: 4574 },
  { index: 8, name: 'Ghostly Green', hsl: 17050 },
  { index: 9, name: 'Obsidian Black', hsl: 0 },
  { index: 10, name: 'Frost White', hsl: 127 },
  { index: 11, name: 'Abyssal Blue', hsl: 40375 },
  { index: 12, name: 'Zamorak Purple', hsl: 50608 },
];

/**
 * Official OSRS hair / beard colors.
 */
export const PLAYER_HAIR_COLORS: ColorSwatch[] = [
  { index: 0, name: 'Dark Brown', hsl: 6798 },
  { index: 1, name: 'White', hsl: 107 },
  { index: 2, name: 'Grey', hsl: 10283 },
  { index: 3, name: 'Black', hsl: 16 },
  { index: 4, name: 'Ginger', hsl: 4797 },
  { index: 5, name: 'Blonde', hsl: 10581 },
  { index: 6, name: 'Chestnut', hsl: 3630 },
  { index: 7, name: 'Light Brown', hsl: 4533 },
  { index: 8, name: 'Turquoise', hsl: 33463 },
  { index: 9, name: 'Green', hsl: 22205 },
  { index: 10, name: 'Crimson Red', hsl: 960 },
  { index: 11, name: 'Purple', hsl: 48697 },
  { index: 12, name: 'Blue', hsl: 42670 },
  { index: 13, name: 'Pink', hsl: 57941 },
  { index: 14, name: 'Silver', hsl: 90 },
];

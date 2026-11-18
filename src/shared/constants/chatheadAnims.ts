export interface ChatheadAnimPreset {
  id: number;
  label: string;
  category: 'human' | 'expression' | 'creature';
  description: string;
}

/**
 * Authentic OSRS chathead dialogue sequence IDs verified against OSRS cache GameVal(7).
 */
export const CHATHEAD_ANIM_PRESETS: ChatheadAnimPreset[] = [
  { id: 591, label: 'Neutral / Default Talk', category: 'human', description: 'chatneu4 — Standard dialogue talking' },
  { id: 588, label: 'Neutral Talk (Short)', category: 'human', description: 'chatneu1 — Brief neutral talking' },
  { id: 589, label: 'Neutral Talk (Medium)', category: 'human', description: 'chatneu2 — Medium neutral talking' },
  { id: 590, label: 'Neutral Talk (Long)', category: 'human', description: 'chatneu3 — Extended neutral talking' },
  { id: 567, label: 'Happy / Cheerful Talk', category: 'human', description: 'chathap1 — Upbeat smiling dialogue' },
  { id: 570, label: 'Happy / Cheerful (Long)', category: 'human', description: 'chathap4 — Extended cheerful dialogue' },
  { id: 610, label: 'Sad / Distressed', category: 'human', description: 'chatsad1 — Downcast sad expression' },
  { id: 613, label: 'Sad / Distressed (Long)', category: 'human', description: 'chatsad4 — Extended sad expression' },
  { id: 614, label: 'Angry / Annoyed', category: 'human', description: 'chatang1 — Furrowed brow angry talk' },
  { id: 617, label: 'Angry / Furious (Long)', category: 'human', description: 'chatang4 — Intense angry dialogue' },
  { id: 605, label: 'Laughing', category: 'human', description: 'chatlaugh1 — Hearty laugh' },
  { id: 608, label: 'Laughing (Long)', category: 'human', description: 'chatlaugh4 — Extended laughing' },
  { id: 592, label: 'Shifty / Suspicious', category: 'human', description: 'chatshifty1 — Sideways glance / shifty' },
  { id: 596, label: 'Scared / Terrified', category: 'human', description: 'chatscared1 — Fearful / trembling' },
  { id: 571, label: 'Shocked / Surprised', category: 'human', description: 'chatshock1 — Wide-eyed shock' },
  { id: 575, label: 'Confused / Contemplative', category: 'human', description: 'chatcon1 — Thinking / confused' },
  { id: 562, label: 'Bored / Unimpressed', category: 'human', description: 'chatbored1 — Bored expression' },
  { id: 600, label: 'Drunk / Tipsy', category: 'human', description: 'chatdrunk1 — Swaying tipsy expression' },
  { id: 554, label: 'Quizzical / Curious', category: 'expression', description: 'chatquiz1 — Inquisitive expression' },
  { id: 558, label: 'Skull / Undead Talk', category: 'creature', description: 'chatskull1 — Skeleton/skull dialogue' },
  { id: 580, label: 'Goblin Talk', category: 'creature', description: 'chatgoblin1 — Goblin dialogue' },
  { id: 584, label: 'Ent / Tree Spirit Talk', category: 'creature', description: 'chatent1 — Ent dialogue' },
];

export const CHATHEAD_PRESET_MAP = new Map<number, ChatheadAnimPreset>(
  CHATHEAD_ANIM_PRESETS.map((p) => [p.id, p])
);

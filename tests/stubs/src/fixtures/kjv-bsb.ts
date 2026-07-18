/**
 * Public-domain KJV/BSB passage fixtures for the YouVersion Data Exchange stub.
 * These are pure response-payload fixtures (there is no Bible-passage DB table —
 * design research), constrained to the only two translations the generation
 * pipeline may source (memory kjv-bsb-generation-only). Keyed by
 * `<version>|<reference>`.
 */
export interface Verse {
  number: number;
  reference: string;
  text: string;
}
export interface PassageFixture {
  reference: string;
  verses: Verse[];
}

function passage(reference: string, verses: Array<[number, string]>): PassageFixture {
  return {
    reference,
    verses: verses.map(([number, text]) => ({
      number,
      reference: `${reference.split(":")[0].replace(/\s\d+.*$/, "")} ${number}`,
      text,
    })),
  };
}

export const PASSAGES: Record<string, PassageFixture> = {
  "kjv|John 3:16": passage("John 3:16", [
    [
      16,
      "For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.",
    ],
  ]),
  "bsb|John 3:16": passage("John 3:16", [
    [
      16,
      "For God so loved the world that He gave His one and only Son, that everyone who believes in Him shall not perish but have eternal life.",
    ],
  ]),
  "kjv|Psalm 121:1-2": passage("Psalm 121:1-2", [
    [1, "I will lift up mine eyes unto the hills, from whence cometh my help."],
    [2, "My help cometh from the LORD, which made heaven and earth."],
  ]),
  "bsb|Psalm 121:1-2": passage("Psalm 121:1-2", [
    [1, "I lift up my eyes to the hills. From where does my help come?"],
    [2, "My help comes from the LORD, the Maker of heaven and earth."],
  ]),
  "kjv|Genesis 1:1": passage("Genesis 1:1", [
    [1, "In the beginning God created the heaven and the earth."],
  ]),
  "bsb|Genesis 1:1": passage("Genesis 1:1", [
    [1, "In the beginning God created the heavens and the earth."],
  ]),
};

/** The only two translations the collection endpoint ever exposes. */
export const BIBLE_COLLECTION = [
  {
    id: "kjv",
    abbreviation: "KJV",
    name: "King James Version",
    language: { iso_639_3: "eng", name: "English" },
    public_domain: true,
  },
  {
    id: "bsb",
    abbreviation: "BSB",
    name: "Berean Standard Bible",
    language: { iso_639_3: "eng", name: "English" },
    public_domain: true,
  },
];

// Shared horizontal geometry for Feed section headers and the rows under them.
//
// The Feed interleaves collapsible sections (Updates, Needs you, Recently completed) with sections that cannot
// collapse (Active work, Squads). Every section title starts on one text column and the disclosure
// chevrons hang to its left, so a chevron is never mistaken for content and titles line up whether or
// not their section collapses.
//
// From sm up, headers keep 12px of inline padding: chevron at 12px, title at 12 + 16 + 8 = 36px, and
// headers without a chevron reserve its width. Below sm that 36px inset squeezes row titles, so the
// title column moves to 12px, in line with the row status dots, and the chevron hangs into the page
// padding: the header pulls 12px left and keeps 4px of padding inside its highlight, and the chevron
// pulls its title 4px closer. Gaps between the title and anything after it stay the same.

/** Inline padding for a collapsible Feed section header's highlight box. */
export const FEED_DISCLOSURE_HEADER_CLASS = '-ml-3 pl-1 pr-3 sm:ml-0 sm:pl-3'

/** For a Feed section header's chevron in a gap-2 row: narrows the space before the title below sm. */
export const FEED_DISCLOSURE_CHEVRON_CLASS = '-mr-1 sm:mr-0'

/** Left inset for Feed rows and their skeleton: the title column from sm up, the header padding below. */
export const FEED_ROW_INSET_CLASS = 'pl-3 sm:pl-9'

/** Left margin for notes under a Feed row, such as status messages: the row's status dot column. */
export const FEED_ROW_TEXT_INSET_CLASS = 'ml-3 sm:ml-9'

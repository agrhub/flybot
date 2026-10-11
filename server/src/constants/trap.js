/**
 * Trap kinds (Camera.trapKind). They count differently:
 *  sticky - a glue card: insects stay where they land, so a photo shows everything caught
 *           since the card was put up; insects caught in a day = the rise of the count.
 *  lure   - an attractant trap without glue: flies come and go, so a photo shows the flies
 *           present at that moment; a day's figure = flies present on average per photo.
 * Card reminders, card-change detection and "card full" only apply to sticky traps.
 */
const TRAP_KINDS = ['sticky', 'lure'];
const DEFAULT_TRAP_KIND = 'sticky';

const trapKindOf = (camera) => (TRAP_KINDS.includes(camera?.trapKind) ? camera.trapKind : DEFAULT_TRAP_KIND);
const isSticky = (camera) => trapKindOf(camera) === 'sticky';

module.exports = {
    TRAP_KINDS,
    DEFAULT_TRAP_KIND,
    trapKindOf,
    isSticky
};

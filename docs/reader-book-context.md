# פתיחת תוסף מתוך ספר בלי סימון טקסט

מפרט מוצע על בסיס אוצריא `0.9.98+801`. ההקשר החדש אינו קיים בגרסה זו. השינוי נוגע לרישום פעולה ולממשק הקריאה בלבד; אין כתיבה לספר, שינוי בסכמת DB או API תיקון ספרים חדש.

## חוזה

להוסיף הקשר כללי `reader-book` לפריטי תפריט תוסף. הוא זמין בקליק ימני על טקסט ראשי בספר, גם ללא בחירה, בכל מצבי הקריאה. אין צורך בהקשר נפרד לצורת הדף. ההרשאות נשארות `reader.context_menu` ו־`app.startup_contributions` לרישום מה־manifest; פתיחת לשונית משתמשת ב־`openPlugin: true` הקיים.

```json
{
  "id": "edit-book",
  "title": "עריכת הספר",
  "contexts": ["reader-book"],
  "openPlugin": true
}
```

אירוע `contextMenu.itemClicked` הקיים נשלח עם `itemId`, `context: 'reader-book'` ו־`selection` תואם לאחור. אובייקט selection מכיל את זהות **הספר שעליו בוצעה הלחיצה**: `id`, `bookId`, `bookTitle`, `bookUid`, `type`, `source`, `sectionIndex` ו־`currentIndex` זהים ואפסיים, וכן `currentBook/currentBookId`. `text` ו־`renderedSelectedText` ריקים; `start/end` הם null; אין `sourceRange`, `renderedRange`, `sections` או `selectionId` מומצאים. `currentRef` הוא null כשאין מיקום מהימן; אין להשתמש בכותרת הפעילה כדי לטעון שהקליק היה במקום אחר. היסט UTF־16 אינו נדרש לפתיחת ספר שלם.

זהות הספר והפסקה נלכדת כשהתפריט נבנה ונשמרת עד הלחיצה וה־boot. שינוי לשונית בזמן פתיחת התוסף לא מחליף אותה. בפריט `reader-book` אין משמעות לטקסט שסומן בפסקה אחרת; פריטי selection הקיימים ממשיכים לקבל את הבחירה האמיתית.

## נקודות חיבור

- `lib/plugins/services/context_menu_registry.dart`: להוסיף `reader-book` לקבוצת `supportedContexts` ב־`_parseItem`. בדיקת startup ב־`PluginExtendedValidator._validateStartupContributions` משתמשת ב־`ContextMenuRegistry.detached().registerPayload`, ולכן ההרחבה צריכה לעבור גם שם בלי מסלול אימות נפרד. לעדכן את סכמת המפרט/ולידטור ה־SDK אם הם מונים הקשרים באופן מפורש.
- `docs/plugin-sdk/otzaria_plugin.d.ts`: להרחיב `ContextMenuContext`; לתעד payload ללא selection range ואת שדה `context` ב־`ContextMenuItemClickedEvent`. לא לשנות את ברירת המחדל של `PluginContextMenuItem.contexts`, כדי שתוספים קיימים לא יופיעו פתאום ללא סימון.
- `lib/text_book/utils/reader_plugin_menu_entries.dart`: `buildReaderPluginMenuEntries` כיום חוזרת ישירות מ־`buildClickedHighlightPluginEntries` כש־`hasSelection == false`. להוסיף builder לטווח הספר ולהרכיב את פריטי `reader-book` יחד עם קבוצת highlight או selection הרלוונטית. לחבר מפריד רק כשיש פריטים. יש לשמור על פריטי highlight קיימים ועל תנאי `showWhenContainsAny`; תנאי תוכן לא יתאים לטקסט ריק.
- זהות הספר תיבנה דרך `PluginBookIdentity.toJsonWithUid(state.book)`; `paragraphIndex` המאומת הוא המיקום האפסי. אין להשתמש ב־`selectedIndex` או במיקום הפעיל כשיש click index.
- `lib/plugins/utils/plugin_context_menu_entries.dart`: להעביר `context` דרך `buildPluginContextMenuEntries` ו־`dispatchPluginContextMenuItemClick`/`_clickPayload` תוך שמירת האירוע הקיים ו־`openPlugin`/תור boot. התוספת אינה מחייבת מופע רקע או הרשאת רקע.
- `combined_view/combined_book_screen.dart` כבר קורא ל־`buildReaderPluginMenuEntries` סביב שורה 1481. `page_shape/simple_text_viewer.dart` קורא לה סביב שורה 2005 רק כאשר `widget.isMainText`; אותה הרחבה תשרת את שני המסלולים. פתיחה מספר פירוש דורשת במכוון builder נפרד עם `widget.reportBook`, ואין לייחס קליק בפירוש לספר הראשי.

## בדיקות שצריכות להיכשל לפני השינוי

1. בדיקת registry: רישום `contexts: ['reader-book']` צריך להצליח; כיום מתקבלת `error.unsupported_context`. startup manifest עם אותו פריט צריך לעבור אימות.
2. להרחיב `test/text_book/utils/reader_plugin_menu_entries_test.dart`: `hasSelection: false`, `root: null`, קליק על פסקה 2 ופריט `reader-book` צריכים להחזיר פעולה אחת. כיום הרשימה ריקה. להפעלה יש להעביר את זהות הספר ואת index 2, עם טקסט ריק וללא range.
3. קליק ללא סימון מעל highlight חייב להחזיר גם את פעולת הספר וגם את פעולת highlight, ללא מפרידים כפולים. עם סימון בפסקה אחרת, פעולת הספר מקבלת את הפסקה שנלחצה ופעולת selection מקבלת את טווח הסימון.
4. צורת הדף: מספר שורות תצוגה של אותה פסקת מקור לא משנות את `sectionIndex`. פירוש צד אינו פותח את הספר הראשי. אירוע שממתין ל־boot שומר snapshot גם לאחר מעבר לספר אחר.

## אימות אינדקסים וסימני תצוגה

`library.getBookToc` בגשר מחזירה `flattenToc(await book.tableOfContents)` ומעתיקה `text/index/level` ללא המרה. אינדקס TOC הוא אפסי: `migration/models/toc_entry.dart` מגדיר `lineIndex` כאפסי, `migrationTocToOtzariaToc` מעתיק אותו ל־`index` (null הופך ל־0), ו־`utils/file/toc_parser.dart` מייצר כותרות מתוך לולאת `i = 0`. זהו אינדקס פסקה, לא היסט תווים, ורשימת TOC היא traversal של עץ ואינה מובטחת כממוינת לפי index. יש לבדוק גבולות לפני ניווט ולא לייחס כותרת null המקור לפסקה מאומתת.

בצורת הדף `primaryLineIndex = segment?.startLineIndex ?? index`; בחלק מאוחד זהו תחילת טווח המקור. תפריט הקליק משתמש בו, ולא במספר השורה שנשברה על המסך. HTML תצוגה מקבל `injectInlineLinks`, `_injectPreviewMarkers`, סימני עוגן והערות אישיות; `sourceLine` ו־payload הראשי נשארים מבוססים על `widget.content`. סימני preview אינם טקסט מקור ואסור להשתמש ב־DOM מוצג לבניית דיווח. `linksByLine[primaryLineIndex + 1]` משתמש במפתח קשרים חד־בסיסי ואינו משנה את ה־SDK sectionIndex האפסי. עבור דיווחים יש לאמת כל פסקה דרך `reader.getSectionTextMap(layer: 'source')`.

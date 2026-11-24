// ==========================================
// quotes.js: the quotes the Today section of the Now Island shows (UI/UX specs, feature 12)
// ==========================================
// A small local file, precached by the service worker (sw.js), so the quote works offline. Two sets, "Developer" and "Motivational".
//
// What may be in here: lines that are in the public domain (old enough that their authors' works are out of copyright, with the author and the
// work they come from) or lines written for CodeMini (credited to "CodeMini"). Nothing from a living author's book, talk or tweet, and nothing
// that only "has been attributed to" someone: a quote with a doubtful source (the internet is full of them) is left out. tests/today.test.js
// checks the shape of every entry: text, an author, a source where it is a historical line.
//
//   t: the text   a: who said it   s: where, for a historical line (shown after the author, and copied with it)
(function (root) {
    'use strict';
    const developer = [
        { t: 'We may say most aptly that the Analytical Engine weaves algebraical patterns just as the Jacquard-loom weaves flowers and leaves.', a: 'Ada Lovelace', s: 'Notes on the Analytical Engine, 1843' },
        { t: 'We can only see a short distance ahead, but we can see plenty there that needs to be done.', a: 'Alan Turing', s: 'Computing Machinery and Intelligence, 1950' },
        { t: 'Name things for the person who reads them next. It is usually you.', a: 'CodeMini' },
        { t: 'A small commit today beats a heroic rewrite next month.', a: 'CodeMini' },
        { t: 'The bug is rarely where you are looking. It is where you stopped looking.', a: 'CodeMini' },
        { t: 'Delete the clever line. Keep the clear one.', a: 'CodeMini' },
        { t: 'If a line needs a comment to say what it does, try a better name first.', a: 'CodeMini' },
        { t: 'Make it run, make it clear, and only then ask whether it needs to be quick.', a: 'CodeMini' },
        { t: 'Every file you leave tidier is a gift to a stranger who will turn out to be you.', a: 'CodeMini' },
        { t: 'Read the error message. It is trying very hard to help.', a: 'CodeMini' },
        { t: 'Take a break. Half of debugging is letting the problem look different.', a: 'CodeMini' },
        { t: 'Ship the smallest thing that is true, then improve it.', a: 'CodeMini' },
        { t: 'Tests are the notes you leave for whoever changes this next.', a: 'CodeMini' },
        { t: 'A good commit message answers one question: why?', a: 'CodeMini' },
        { t: 'Everyone has deleted something they needed. Commit early, commit often.', a: 'CodeMini' },
        { t: 'Rename the variable. The bug may have been hiding behind the bad name.', a: 'CodeMini' },
        { t: 'Simple code is not the first draft. It is the last.', a: 'CodeMini' },
        { t: 'Your future self is a user too. Write for them.', a: 'CodeMini' }
    ];
    const motivational = [
        { t: 'Well done is better than well said.', a: 'Benjamin Franklin', s: 'Poor Richard\u2019s Almanack, 1733\u20131758' },
        { t: 'Lost time is never found again.', a: 'Benjamin Franklin', s: 'The Way to Wealth, 1758' },
        { t: 'Nothing will ever be attempted, if all possible objections must be first overcome.', a: 'Samuel Johnson', s: 'Rasselas, 1759' },
        { t: 'Nothing great was ever achieved without enthusiasm.', a: 'Ralph Waldo Emerson', s: 'Circles, 1841' },
        { t: 'If one advances confidently in the direction of his dreams, and endeavors to live the life which he has imagined, he will meet with a success unexpected in common hours.', a: 'Henry David Thoreau', s: 'Walden, 1854' },
        { t: 'Start with ten minutes. Momentum does the rest.', a: 'CodeMini' },
        { t: 'Progress counts even when nobody is watching.', a: 'CodeMini' },
        { t: 'You do not need to see the whole path, only the next step.', a: 'CodeMini' },
        { t: 'Today\u2019s small effort is tomorrow\u2019s easy habit.', a: 'CodeMini' },
        { t: 'Rest is part of the work, not a break from it.', a: 'CodeMini' },
        { t: 'Be patient with the beginner you were yesterday.', a: 'CodeMini' },
        { t: 'Done and imperfect beats perfect and unfinished.', a: 'CodeMini' },
        { t: 'The hardest part is opening the file.', a: 'CodeMini' },
        { t: 'Learning feels slow until you look back.', a: 'CodeMini' },
        { t: 'Curiosity is a skill. Practise it.', a: 'CodeMini' }
    ];
    const data = Object.freeze({ developer: Object.freeze(developer), motivational: Object.freeze(motivational) });
    if (typeof module !== 'undefined' && module.exports) module.exports = data;
    root.CODEMINI_QUOTES = data;
})(typeof window !== 'undefined' ? window : globalThis);

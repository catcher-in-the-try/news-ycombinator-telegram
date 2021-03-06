const cheerio = require('cheerio');
const fs = require('fs');
const request = require('request-promise-native');

// Name of this Azure Function. Needed for filesystem ops.
const THIS_FUNCTION_NAME = 'ycomb-poster';

// Telegram settings
const NEWS_URL = 'https://news.ycombinator.com/';
const SILENT_BROADCAST = true;
const TELEGRAM_BOT_TOKEN = <INSERT TELEGRAM BOT TOKEN FROM @botfather HERE>;
const TELEGRAM_CHANNEL = '@news_ycombinator';
const TELEGRAM_POST_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHANNEL}&parse_mode=Markdown${SILENT_BROADCAST ? '&disable_notification=true' : '' }&text=`;

// Hacker News settings:
const COMMENTS_SELECTOR = '.itemlist .subtext > a:last-child';
const NEWS_CONTAINER_SELECTOR = '.itemlist';
const NEWS_ITEM_SELECTOR = '.athing';
const NEWS_LINK_SELECTOR = 'a.storylink';
const SCORE_SELECTOR = '.score';
const SUBTEXT_SELECTOR = '.itemlist .subtext';
const MIN_VOTE_REQUIRED = 20;

// Other settings:
const SENT_ITEMS_FILENAME = `./${THIS_FUNCTION_NAME}/sent.json`;
const REMOVE_FROM_LOG_AFTER = 15 * 24 * 60 * 60 * 1000; // 15 days

module.exports = async function (context, myTimer) {
    context.log('Starting up...');
    
    try {
        const html = await fetchHtml();

        context.log('HTML fetched.');

        const $ = cheerio.load(html);
        const $articles = getArticles($);
        const votes = collectVoteCounts($);
        const {links, comments} = collectCommentLinks($);
        const newsItems = extractNewsFromHtml($, $articles, votes, links, comments);
        
        context.log(`Fetched ${newsItems.length} articles.`);

        // Leave only those news items that have not been sent
        // to channel before, according to our log.
        const sentLog = readSentLog();
        const newItems = selectNewItemsOnly(sentLog, newsItems);

        // We are sending each new item to the channel, but before
        // that we mark it in the log as sent, to avoid sending
        // it again.
        for (let newItem of newItems) {
            context.log(`Sending ${newItem.title}...`);
            markItemSent(sentLog, newItem);
            await sendMessageToTelegram(generateMessage(newItem));
        }

        removeOldItemsFromLog(sentLog);
    } catch (error) {
        context.log(`Critical error: ${error.message}`);
    }

    context.log('All done!');
    context.done();
};

async function fetchHtml() {
    return await request({
        method: 'GET',
        uri: NEWS_URL,
    });
}

function getArticles($) {
    return $(NEWS_CONTAINER_SELECTOR + ' ' + NEWS_ITEM_SELECTOR);
}

function collectVoteCounts($) {
    let votes = [];
    $(SUBTEXT_SELECTOR).each((i, element) => {
        let scoreElement = $(element).find(SCORE_SELECTOR);

        // If the score is zero the '.score' element is missing:
        if (!scoreElement || scoreElement.length === 0) {
            votes.push(0);
        } else {
            // The text is like "42 points":
            votes.push(parseInt($(scoreElement).text()));
        }
    });
    return votes;
}

function collectCommentLinks($) {
    let links = [];
    let comments = []
    $(COMMENTS_SELECTOR).each((i, element) => {
        links.push(NEWS_URL + $(element).attr('href'));
        comments.push($(element).text());
    });
    return { links, comments };
}

function extractNewsFromHtml($, $articles, votes, links, comments) {
    let news = [];
    $articles.each(function(i, article) {
        let $link = $(article).find(NEWS_LINK_SELECTOR);
        let url = $link.attr('href');
        let title = $link.text();
        let score = votes[i];
        let commentLink = links[i];
        let commentCount = comments[i];

        // Escape _, otherwise it turns to italic:
        url = url.replace(/_/g, '\\_');

        // Handle self-posts which are relative URLs:
        if (!url.toLowerCase().startsWith('http')) {
            url = NEWS_URL + url;
        }
        
        news.push({url, title, score, commentLink, commentCount});
    });
    return news;
}

function generateMessage(item) {
    return `*${item.title}*\r\n${item.url} | [${item.commentCount}](${item.commentLink})`;
}

function selectNewItemsOnly(log, items) {
    return items.filter(item => !log.sent[item.url] && item.score > MIN_VOTE_REQUIRED);
}

function readSentLog() {
    if (fs.existsSync(SENT_ITEMS_FILENAME)) {
        let file = fs.readFileSync(SENT_ITEMS_FILENAME, 'utf8');
        return JSON.parse(file);
    } else {
        return { sent: {} };
    }
}

async function sendMessageToTelegram(message) {
    await request({
        method: 'GET',
        uri: TELEGRAM_POST_URL + encodeURIComponent(message),
    });
}

function markItemSent(log, item) {
    // Date is saved to later clean up old log records.
    // To avoid resending the same item in case of error,
    // we immediately save log to disk.
    log.sent[item.url] = Date.now();
    fs.writeFileSync(SENT_ITEMS_FILENAME, JSON.stringify(log));
}

function removeOldItemsFromLog(log) {
    let urls = Object.keys(log);
    for (let url of urls) {
        if (Date.now() - log.sent[url] > REMOVE_FROM_LOG_AFTER) {
            delete log.sent[url];
        }
    }
    fs.writeFileSync(SENT_ITEMS_FILENAME, JSON.stringify(log, null, 2));
}

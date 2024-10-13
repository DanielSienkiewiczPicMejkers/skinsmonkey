const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { exec } = require('child_process');
const SteamTotp = require('steam-totp');
const fs = require('fs/promises');
const path = require('path');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');
const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const FS = require('fs');
const SteamClientManager = require('./steamClientManager');

let globalUrl = null; // Global variable to store the URL

const credentials = {
    username: 'your_username',
    password: 'your_password',
    sharedSecret: 'your_shared_secret',
    identitySecret: 'your_identity_secret'
};

async function extractUrl(emailusername, emailpassword, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const imap = new Imap({
                    user: emailusername,
                    password: emailpassword,
                    host: 'imap.firstmail.ltd',
                    port: 993,
                    tls: true
                });

                imap.once('ready', function() {
                    imap.openBox('INBOX', false, function(err, box) {
                        if (err) {
                            console.error('Error opening inbox:', err);
                            imap.end();
                            return reject(err);
                        }

                        imap.search(['ALL'], function(err, results) {
                            if (err || !results.length) {
                                console.log('No emails found.');
                                imap.end();
                                return reject(new Error('No emails found'));
                            }

                            const f = imap.fetch(results[results.length - 1], { bodies: [''] });
                            f.on('message', function(msg, seqno) {
                                msg.on('body', function(stream, info) {
                                    simpleParser(stream, async (err, mail) => {
                                        if (err) {
                                            console.error('Error parsing email:', err);
                                            imap.end();
                                            return reject(err);
                                        }

                                        const emailContent = mail.html || mail.text;
                                        const $ = cheerio.load(emailContent);

                                        const link = $("div[style=\"font-family:'Helvetica Neue', Helvetica, sans-serif;font-size:14px;font-weight:400;line-height:1.5;text-align:left;color:#21201e;\"] a").attr('href');

                                        if (link) {
                                            globalUrl = link;
                                            imap.end();
                                            resolve(globalUrl);
                                        } else {
                                            console.log("No verification URL found in the email.");
                                            imap.end();
                                            reject(new Error("No verification URL found in the email."));
                                        }
                                    });
                                });
                            });

                            f.once('error', function(err) {
                                console.error('Fetch error:', err);
                                imap.end();
                                reject(err);
                            });
                        });
                    });
                });

                imap.once('end', function() {
                    console.log('IMAP connection ended');
                });

                imap.once('error', function(err) {
                    console.error('IMAP connection error:', err);
                    reject(err);
                });

                imap.connect();
            });
        } catch (error) {
            if (error.message.includes("No verification URL found in the email") && attempt < maxRetries - 1) {
                console.log(`Retrying to extract URL in 5 seconds... Attempt ${attempt + 1} of ${maxRetries}`);
                await wait(5000); // Wait for 3 seconds before retrying
            } else {
                throw error; // If it's another error or max retries reached, throw the error
            }
        }
    }
    throw new Error('Max retries reached without finding the verification URL');
}



class Credentials {
    constructor(id, username, password, emailUsername, emailPassword, sharedSecret, identitySecret) {
        this.id = id;
        this.username = username;
        this.password = password;
        this.emailUsername = emailUsername;
        this.emailPassword = emailPassword;
        this.sharedSecret = sharedSecret;
        this.identitySecret = identitySecret;
    }
}

class ProxyConfig {
    constructor(server, username, password) {
        this.server = server;
        this.username = username;
        this.password = password;
    }
}

// Utility function to pause execution for a given number of milliseconds
function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}


async function readData(filePath, mapper) {
    const data = await fs.readFile(filePath, 'utf8');
    return data.split('\n').filter(line => line.trim()).map(mapper).filter(item => item !== null);
}

async function typeTextByXPath(page, xpath, textToType, timeout = 15000) {
    try {
        await page.waitForFunction(xpath => {
            return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        }, { timeout }, xpath);

        await page.evaluate((xpath, textToType) => {
            const input = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (input) {
                input.focus();
                input.value = textToType;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, xpath, textToType);
    } catch (error) {
        console.error('Error typing into the input field:', error);
    }
}

async function clickButtonByXPath(page, xpath, timeout = 15000) {
    try {
        await page.waitForFunction(xpath => {
            return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        }, { timeout }, xpath);

        await page.evaluate(xpath => {
            const button = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (button) {
                button.click();
            }
        }, xpath);
    } catch (error) {
        console.error('Error clicking the button:', error);
    }
}

async function handleSession(credentials, proxyConfig) {
    let browser = null;
    const steamManager = new SteamClientManager(proxyConfig);

    try {
        browser = await puppeteer.launch({
            headless: false,
            args: [
                `--proxy-server=http://${proxyConfig.server}`, // Assuming proxy server is HTTP
                '--disable-extensions',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-web-security', // Only use if absolutely necessary.
                '--disable-software-rasterizer',
            ]
        });
        const page = await browser.newPage();
        await page.authenticate({
            username: proxyConfig.username,
            password: proxyConfig.password
        });
        await page.setViewport({
            width: 1200,
            height: 650
        });

        console.log(`Logging in with ${credentials.username} using proxy ${proxyConfig.server}`);

        // Perform login actions
        await performLoginActions(page, credentials, steamManager);

        // Use steamManager to initiate Steam client
        await steamManager.initiateSteamClient(credentials);
        console.log('Steam client initiated and logged in. Waiting for trades...');

        // Wait for a trade or timeout
        await Promise.race([
            new Promise(resolve => {
                steamManager.manager.on('receivedOfferChanged', (offer, oldState) => {
                    if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                        console.log(`Trade offer ${offer.id} was accepted. Moving to next account.`);
                        resolve();
                    }
                });
            }),
            new Promise(resolve => setTimeout(() => {
                console.log("Timeout reached. Moving to next account.");
                resolve();
            }, 30000)) // 15 minutes timeout, adjust as needed
        ]);

    } catch (error) {
        console.error(`Session failed for ${credentials.username}:`, error);
        // ... error handling ...
    } finally {
        // Use steamManager to log off from Steam
        await steamManager.logOffFromSteam();
        if (browser) {
            await browser.close();
        }
    }
}






async function performLoginActions(page, credentials, steamManager) {
    await page.goto('https://steamcommunity.com/openid/login?openid.mode=checkid_setup&openid.ns=http://specs.openid.net/auth/2.0&openid.identity=http://specs.openid.net/auth/2.0/identifier_select&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select&openid.return_to=https://skinsmonkey.com/auth/steam/callback', { waitUntil: 'networkidle2', timeout: 18000 });

    const usernameSelector = '#responsive_page_template_content > div.page_content > div:nth-child(1) > div > div > div > div._3XCnc4SuTz8V8-jXVwkt_s > div > form > div:nth-child(1) > input';
    await page.waitForSelector(usernameSelector, { visible: true, timeout: 18000 });
    await page.type(usernameSelector, credentials.username);

    const passwordSelector = '#responsive_page_template_content > div.page_content > div:nth-child(1) > div > div > div > div._3XCnc4SuTz8V8-jXVwkt_s > div > form > div:nth-child(2) > input';
    const submitButtonSelector = '#responsive_page_template_content > div.page_content > div:nth-child(1) > div > div > div > div._3XCnc4SuTz8V8-jXVwkt_s > div > form > div._16fbihk6Bi9CXuksG7_tLt > button';
    await page.type(passwordSelector, credentials.password);
    await page.click(submitButtonSelector);

    var code = SteamTotp.generateAuthCode(credentials.sharedSecret);

    await page.waitForSelector('#responsive_page_template_content > div.page_content > div:nth-child(1) > div > div > div > div._3XCnc4SuTz8V8-jXVwkt_s > div > div._3yz6xIaXDcStXAUzK4pWgE > div > div', { visible: true });
    await page.click('#responsive_page_template_content > div.page_content > div:nth-child(1) > div > div > div > div._3XCnc4SuTz8V8-jXVwkt_s > div > div._3yz6xIaXDcStXAUzK4pWgE > div > div');

    await page.waitForSelector('#responsive_page_template_content > div.page_content > div:nth-child(1) > div > div > div > div._3XCnc4SuTz8V8-jXVwkt_s > form > div > div._3huyZ7Eoy2bX4PbCnH3p5w > div._1NOsG2PAO2rRBb8glCFM_6._2QHQ1DkwVuPafY7Yr1Df6w > div', { visible: true });
    await page.type('#responsive_page_template_content > div.page_content > div:nth-child(1) > div > div > div > div._3XCnc4SuTz8V8-jXVwkt_s > form > div > div._3huyZ7Eoy2bX4PbCnH3p5w > div._1NOsG2PAO2rRBb8glCFM_6._2QHQ1DkwVuPafY7Yr1Df6w > div', code);

    const signInButtonSelector = '#imageLogin';
    await page.waitForSelector(signInButtonSelector, { visible: true, timeout: 18000 });
    await page.click(signInButtonSelector);

    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 17000 });

    const buttonSelector = 'button.G_Button.default.green';
    console.log(credentials.emailPassword);

    const tradeUrlLink1 = 'a[href="https://steamcommunity.com/my/tradeoffers/privacy#trade_offer_access_url"]';
    await page.waitForSelector(tradeUrlLink1, { visible: true, timeout: 18000 });
    await page.goto('https://steamcommunity.com/my/tradeoffers/privacy#trade_offer_access_url', { waitUntil: 'networkidle2', timeout: 10000 });

    await page.waitForSelector('input.trade_offer_access_url', { visible: true });
    const tradeUrl = await page.evaluate(() => document.querySelector('input.trade_offer_access_url').value);
    await page.goto('https://skinsmonkey.com/pl/trade', { waitUntil: 'networkidle2', timeout: 10000 });
    const tradeUrlLink2 = 'a[href="https://steamcommunity.com/my/tradeoffers/privacy#trade_offer_access_url"]';
    await page.waitForSelector(tradeUrlLink2, { visible: true, timeout: 18000 });
    await typeTextByXPath(page, '/html/body/div[1]/div/div/div[4]/div/div/div/div/div/div[1]/form/div[1]/div/input', tradeUrl);
    await typeTextByXPath(page, '/html/body/div[1]/div/div/div[4]/div/div/div/div/div/div[1]/form/div[2]/div/input', credentials.emailUsername);
    await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[4]/div/div/div/div/div/div[1]/form/div[3]/label/span[1]');
    await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[4]/div/div/div/div/div/div[1]/form/div[4]');
    await wait(3333);
    await page.goto('https://steamcommunity.com/groups/skinsmonkey', { waitUntil: 'networkidle2', timeout: 15000 });
    await clickButtonByXPath(page, '/html/body/div[1]/div[7]/div[5]/div[1]/div[1]/div/div[1]/div[2]/div[4]/div/a/span');
    await wait(7777);

    //console.log('Starting URL extraction...');
    await extractUrl(credentials.emailUsername, credentials.emailPassword);
    //console.log('URL extracted:', globalUrl);

    if (globalUrl && typeof globalUrl === 'string' && globalUrl.trim() !== '') {
        console.log('Navigating to:', globalUrl);
        await page.goto(globalUrl, { waitUntil: 'networkidle2', timeout: 10000 });
    } else {
        console.error('Failed to extract URL or URL is invalid:', globalUrl);
    }

    await page.goto('https://skinsmonkey.com/free-csgo-skins', { waitUntil: 'networkidle2', timeout: 15000 });
    await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/section[2]/div[2]/div/div[1]/div[3]/div/div/span');
    await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[4]/div/div/div/div/div[2]/div/div[2]/div/div/div');
    await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/section[2]/div[2]/div/div[3]/div[3]/div/div');
    await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[4]/div/div/div/div/div[2]/div/div[2]/div[2]/div');
    await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/section[2]/div[2]/div/div[3]/div[3]/div/div');
    await wait(777);
    await page.goto('https://skinsmonkey.com/trade', { waitUntil: 'networkidle2', timeout: 15000 });
    await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[3]/div[2]/div[3]/div/div[1]/div/span');
    await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[3]/div[2]/div[3]/div[2]/div[3]/div/div/span');
    // Wait for the specific item card element to be visible
    await page.waitForSelector('div.item-card__body img[alt="Refined Metal"]', { visible: true });

    // Click on the parent item card element
    await page.click('div.item-card__body img[alt="Refined Metal"]');
    await wait(555);
    async function handleRefreshAccountButton(page) {
        try {
            // Check if the button exists
            const buttonExists = await page.evaluate(() => {
                const button = document.querySelector('div.base-button.transparent[role="button"] > div.base-button__label > span');
                return button && button.textContent.trim() === 'Refresh Account';
            });
    
            if (buttonExists) {
                // If the button exists, click it
                await page.evaluate(() => {
                    const button = document.querySelector('div.base-button.transparent[role="button"] > div.base-button__label > span');
                    if (button && button.textContent.trim() === 'Refresh Account') {
                        button.click();
                    }
                });
                await wait(12555)
                //console.log('Refresh Account button found and clicked.');
            } else {
                console.log('Refresh Account button not found, moving to the next operation.');
                // Insert the logic for the next operation here
                // For example, you can navigate to a different page or perform another action
            }
        } catch (error) {
            console.error('Error handling the Refresh Account button:', error);
        }
    }
    
    // Usage
    await handleRefreshAccountButton(page);
    await handleRefreshAccountButton(page);
    await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[2]/div[1]/div/div[1]/div/span');
    await wait(2222)
    const messageSelector = '#__layout > div > div.modal.modal--order-missing > div > div > div > div > div.modal-order.modal-order-missing.modal__core > div.modal-body.modal-order__body > div.prompt.small.emoji > div.prompt__inner';

    try {
        // Wait for the message to appear
        // Wait for the element with the specific selector to be visible
        const messageVisible = await page.$(messageSelector);


        if (messageVisible) {
            console.log('Detected message: Item has been bought by another user.');
            // Perform the actions when the item is bought by another user
            await page.reload({ waitUntil: 'networkidle2' });
                // Wait for the specific item card element to be visible
            await page.waitForSelector('div.item-card__body img[alt="Refined Metal"]', { visible: true });
            const itemSelector = 'div.item-card__body img[alt="Refined Metal"]';
            await page.click(itemSelector);
            await wait(222)
            await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[3]/div[3]/div/div/div[2]/div[5]/div/div/div[1]/div[3]/div/div[2]')
            await wait(222)
            await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[3]/div[3]/div/div/div[2]/div[5]/div/div/div[1]/div[3]/div/div[2]')
            await wait(222)
            await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[3]/div[1]/div[2]/div/div/div/div/div/div[3]/div[2]')
            await wait(555)
            await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[3]/div[1]/div[2]/div/div/div/div/div/div[1]/div[2]')
            await wait(555)
            await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[2]/div[1]/div/div[1]/div/span');
            await wait(2111)
        } else {
            console.log('No message detected, proceeding with the alternate script.');
            // Perform the other actions when the item is not bought
        }
    } catch (error) {
        console.error('Error detecting the message:', error);
    }
    const messageSelector1 = '#__layout > div > div.modal.modal--order-missing > div > div > div > div > div.modal-order.modal-order-missing.modal__core > div.modal-body.modal-order__body > div.prompt.small.emoji > div.prompt__inner';

    try {
        // Wait for the message to appear
        // Wait for the element with the specific selector to be visible
        const messageVisible1 = await page.$(messageSelector1);


        if (messageVisible1) {
            console.log('Detected message: Item has been bought by another user.');
            // Perform the actions when the item is bought by another user
            await page.reload({ waitUntil: 'networkidle2' });
                // Wait for the specific item card element to be visible
            await page.waitForSelector('div.item-card__body img[alt="Refined Metal"]', { visible: true });
            const itemSelector = 'div.item-card__body img[alt="Refined Metal"]';
            await page.click(itemSelector);
            await wait(222)
            await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[3]/div[3]/div/div/div[2]/div[5]/div/div/div[1]/div[3]/div/div[2]')
            await wait(222)
            await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[3]/div[3]/div/div/div[2]/div[5]/div/div/div[1]/div[3]/div/div[2]')
            await wait(222)
            await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[3]/div[3]/div/div/div[2]/div[5]/div/div/div[1]/div[3]/div/div[2]')
            await wait(222)
            await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[3]/div[3]/div/div/div[2]/div[5]/div/div/div[1]/div[3]/div/div[2]')
            await wait(222)
            await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[3]/div[1]/div[2]/div/div/div/div/div/div[3]/div[2]')
            await wait(225)
            await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[3]/div[1]/div[2]/div/div/div/div/div/div[1]/div[2]')
            await wait(225)
            await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[3]/div[1]/div[2]/div/div/div/div/div/div[3]/div[2]')
            await wait(225)
            await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[3]/div[1]/div[2]/div/div/div/div/div/div[1]/div[2]')
            await wait(225)
            await clickButtonByXPath(page, '/html/body/div[1]/div/div/div[2]/div/div[2]/div[1]/div/div[1]/div/span');
            await wait(1111)
        } else {
            console.log('No message detected, proceeding with the alternate script.');
            // Perform the other actions when the item is not bought
        }
    } catch (error) {
        console.error('Error detecting the message:', error);
    }
    try {
        await steamManager.initiateSteamClient(credentials);
        console.log('Steam client initiated and logged in. Waiting for trades...');

        // The client will stay logged in and handle trades until you decide to log off
        // You might want to add some way to trigger the logout, like a timer or user input

        // For example, to log off after 1 hour:
        // setTimeout(() => steamManager.logOffFromSteam(), 3600000);

        // Or you could set up a process to handle a shutdown signal:
        process.on('SIGINT', async () => {
            console.log('Shutdown signal received. Logging off...');
            await steamManager.logOffFromSteam();
            process.exit(0);
        });

    } catch (error) {
        console.error('Error during Steam client initiation:', error);
    }
}



(async () => {
    const credentialsPath = path.join(__dirname, 'konta1.txt');
    const proxyPath = path.join(__dirname, 'Webshare1.txt');

    const credentials = await readData(credentialsPath, line => {
        const parts = line.split(':');
        if (parts.length >= 7) {
            return new Credentials(parts[0].trim(), parts[1].trim(), parts[2].trim(), parts[3].trim(), parts[4].trim(), parts[5].trim(), parts[6].trim());
        }
        console.error(`Invalid credentials format: ${line}`);
        return null;
    });

    const proxies = await readData(proxyPath, line => {
        const parts = line.split(':');
        if (parts.length === 4) {
            return new ProxyConfig(`${parts[0].trim()}:${parts[1].trim()}`, parts[2].trim(), parts[3].trim());
        }
        console.error(`Invalid proxy format: ${line}`);
        return null;
    });

    for (let i = 0; i < credentials.length; i++) {
        try {
            await handleSession(credentials[i], proxies[i % proxies.length]);
            await wait(1000);
        } catch (error) {
            console.error(`Error with credentials ${credentials[i].username}:`, error);
            const filePath = 'niedziala.txt';
            const dataToWrite = `${credentials[i].id}:${credentials[i].username}:${credentials[i].password}:${credentials[i].emailUsername}:${credentials[i].emailPassword}:${credentials[i].sharedSecret}:${credentials[i].identitySecret}\n`;
            try {
                await fs.writeFile(filePath, dataToWrite, { flag: 'a' });
                console.log(`Data was written to ${filePath} successfully!`);
            } catch (error) {
                console.error('Failed to write to file:', error);
            }
        }
    }
})();

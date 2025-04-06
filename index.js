#!/usr/bin/env node

// Çevresel değişkenleri yükle
require('dotenv').config();

const { Server } = require("@modelcontextprotocol/sdk/server");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio");
const { z } = require("zod");
const axios = require("axios");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

// Konfigürasyon ayarları
const CONFIG = {
    apiKey: process.env.FREEPIK_API_KEY,
    timeout: parseInt(process.env.REQUEST_TIMEOUT || '30000'),
    retryAttempts: parseInt(process.env.RETRY_ATTEMPTS || '3'),
    apiBaseUrl: "https://api.freepik.com/v1/ai/text-to-image/flux-dev"
};

// API anahtarı kontrolü
if (!CONFIG.apiKey) {
    console.error("Freepik API anahtarı bulunamadı. Lütfen .env dosyasında FREEPIK_API_KEY değişkenini ayarlayın.");
    console.log("Örnek .env dosyası için .env.example dosyasını kontrol edin.");
    process.exit(1);
}

// MCP sunucusu oluşturma
const server = new Server({
    name: "Freepik-FluxAI",
    version: "1.0.0"
});

// Kullanılabilir görsel oranları
const aspectRatios = [
    "square_1_1",
    "classic_4_3",
    "traditional_3_4",
    "widescreen_16_9",
    "social_story_9_16",
    "standard_3_2",
    "portrait_2_3",
    "horizontal_2_1",
    "vertical_1_2",
    "social_post_4_5"
];

// Temel görsel oluşturma aracı
server.tool(
    "generate_image",
    { 
        prompt: z.string().describe("Görsel için metin açıklaması"),
        aspect_ratio: z.enum(aspectRatios).optional().describe("Görsel oranı (örn: square_1_1, widescreen_16_9)")
    },
    async ({ prompt, aspect_ratio }) => {
        // API isteği için verileri oluştur
        const requestData = { prompt };
        if (aspect_ratio) requestData.aspect_ratio = aspect_ratio;

        try {
            console.log("Görsel oluşturma isteği gönderiliyor:", requestData);
            
            // Freepik API'sine istek gönder
            let createRes;
            let retryCount = 0;
            
            while (retryCount < CONFIG.retryAttempts) {
                try {
                    createRes = await axios.post(
                        CONFIG.apiBaseUrl,
                        requestData,
                        {
                            headers: {
                                "Content-Type": "application/json",
                                "x-freepik-api-key": CONFIG.apiKey
                            },
                            timeout: CONFIG.timeout
                        }
                    );
                    break; // Başarılı olduğunda döngüden çık
                } catch (error) {
                    retryCount++;
                    console.error(`API isteği başarısız oldu (${retryCount}/${CONFIG.retryAttempts}): ${error.message}`);
                    
                    if (retryCount >= CONFIG.retryAttempts) {
                        throw new Error(`Maksimum yeniden deneme sayısına ulaşıldı: ${error.message}`);
                    }
                    
                    // Eksponansiyel geri çekilme (exponential backoff)
                    const waitTime = Math.min(1000 * Math.pow(2, retryCount), 10000);
                    console.log(`${waitTime} ms sonra tekrar denenecek...`);
                    await new Promise(res => setTimeout(res, waitTime));
                }
            }
            
            if (!createRes || !createRes.data || !createRes.data.data || !createRes.data.data.task_id) {
                throw new Error("API'den geçersiz yanıt alındı.");
            }
            
            console.log("API yanıtı alındı:", createRes.data);
            
            // Task ID al
            const taskId = createRes.data.data.task_id;
            let imageUrl = null;

            // Task durumunu kontrol etme fonksiyonu
            const checkTaskStatus = async (taskId) => {
                const maxChecks = 30; // Maksimum 60 saniye (2 saniye aralıklarla 30 kontrol)
                let checkCount = 0;
                
                while (checkCount < maxChecks) {
                    try {
                        const statusRes = await axios.get(
                            `${CONFIG.apiBaseUrl}/${taskId}`,
                            {
                                headers: { "x-freepik-api-key": CONFIG.apiKey },
                                timeout: CONFIG.timeout
                            }
                        );
                        
                        if (!statusRes.data || !statusRes.data.data) {
                            throw new Error("Task durumu için geçersiz yanıt alındı.");
                        }
                        
                        const status = statusRes.data.data.status;
                        console.log(`Task durumu (${checkCount + 1}/${maxChecks}):`, status);
                        
                        if (status === "COMPLETED") {
                            if (statusRes.data.data.generated && statusRes.data.data.generated.length > 0) {
                                return {
                                    success: true,
                                    url: statusRes.data.data.generated[0],
                                    status: status
                                };
                            } else {
                                throw new Error("Görsel tamamlandı ancak URL bulunamadı.");
                            }
                        }
                        
                        if (["FAILED", "ERROR", "REJECTED"].includes(status)) {
                            return {
                                success: false,
                                message: `Görsel oluşturma işlemi başarısız oldu: ${status}`,
                                status: status
                            };
                        }
                        
                    } catch (error) {
                        console.error(`Task durum kontrolünde hata (${checkCount + 1}/${maxChecks}):`, error.message);
                        // Hata durumunda işleme devam et, tamamen çıkma
                    }
                    
                    checkCount++;
                    // 2 saniye bekle
                    await new Promise(res => setTimeout(res, 2000));
                }
                
                throw new Error(`Task durumu kontrol süresi aşıldı (${maxChecks * 2} saniye)`);
            };
            
            // Task durumunu kontrol et
            console.log("Task durumu kontrol ediliyor:", taskId);
            const taskResult = await checkTaskStatus(taskId);
            
            if (!taskResult.success) {
                throw new Error(taskResult.message);
            }
            
            imageUrl = taskResult.url;
            console.log("Görsel URL'si alındı:", imageUrl);

            if (!imageUrl) {
                throw new Error("Görsel URL'si alınamadı.");
            }

            // Görseli tarayıcıda açma fonksiyonu
            const openInBrowser = (url) => {
                return new Promise((resolve, reject) => {
                    let command;
                    if (process.platform === "win32") {
                        command = `start "" "${url}"`;
                    } else if (process.platform === "darwin") {
                        command = `open "${url}"`;
                    } else {
                        command = `xdg-open "${url}"`;
                    }
                    
                    exec(command, (error) => {
                        if (error) {
                            console.error(`Tarayıcı açma hatası: ${error.message}`);
                            reject(error);
                        } else {
                            console.log(`Görsel tarayıcıda açıldı: ${url}`);
                            resolve();
                        }
                    });
                });
            };
            
            // Görseli tarayıcıda aç
            try {
                await openInBrowser(imageUrl);
            } catch (error) {
                console.error("Görsel tarayıcıda açılamadı, ancak URL döndürülebilir.");
                // Bu hatada işlemi durdurmuyoruz, sadece logluyoruz
            }

            // Sonucu döndür
            return {
                content: [
                    {
                        type: "text",
                        text: `Görsel başarıyla oluşturuldu!\n` +
                              `Görsel tarayıcınızda otomatik olarak açıldı.\n\n` +
                              `Üretilen Görsel URL: ${imageUrl}`
                    }
                ]
            };
        } catch (error) {
            console.error("Görsel oluşturma işleminde hata:", error);
            
            // Hata türüne göre daha anlaşılır mesajlar oluştur
            let errorMessage = error.message;
            
            if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                errorMessage = "Freepik API'sine bağlanamıyor. Lütfen internet bağlantınızı kontrol edin.";
            } else if (error.code === 'ETIMEDOUT' || error.code === 'TIMEOUT') {
                errorMessage = "Freepik API'si yanıt vermiyor veya çok yavaş. Lütfen daha sonra tekrar deneyin.";
            } else if (error.response) {
                // API yanıtını aldık, ancak 2xx değil
                const status = error.response.status;
                if (status === 401 || status === 403) {
                    errorMessage = "API anahtarı geçersiz veya yetkisiz. Lütfen .env dosyanızı kontrol edin.";
                } else if (status === 400) {
                    errorMessage = "Geçersiz istek parametreleri. Lütfen prompt'unuzu kontrol edin.";
                } else if (status >= 500) {
                    errorMessage = "Freepik API'si şu anda hata veriyor. Lütfen daha sonra tekrar deneyin.";
                }
            }
            
            return {
                content: [
                    {
                        type: "text",
                        text: `Görsel oluşturulurken bir hata oluştu:\n` +
                              `${errorMessage}\n\n` +
                              `Teknik Detay: ${error.message}\n` +
                              `Lütfen tekrar deneyin veya farklı bir istek yapın.`
                    }
                ]
            };
        }
    }
);

// Yardım kaynağı
server.resource(
    "help",
    async () => {
        return {
            content: [
                {
                    type: "text",
                    text: `Freepik Flux AI - Yardım Bilgisi\n\n` +
                          `Bu MCP sunucusu, Freepik'in Flux AI görsel üretme API'sini kullanarak metin açıklamalarından görseller oluşturmanızı sağlar.\n\n` +
                          `Kullanılabilir Araçlar:\n` +
                          `1. generate_image: Metin açıklaması ve görsel oranı (isteğe bağlı) ile görsel oluşturur.\n\n` +
                          `Örnek Kullanım:\n` +
                          `- "Bana dağların ve gölün olduğu bir manzara görseli oluştur"\n` +
                          `- "Geniş ekran formatında (16:9) bir plaj manzarası oluştur"`
                }
            ]
        };
    }
);

// Claude ile bağlantı kur
console.log("Freepik MCP sunucusu başlatılıyor...");
const transport = new StdioServerTransport();
server.connect(transport);
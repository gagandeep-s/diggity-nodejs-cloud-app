/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for t`he specific language governing permissions and
 * limitations under the License.
 */
'use strict';

// [START import]
const functions = require('firebase-functions');
const gcs = require('@google-cloud/storage')();
const spawn = require('child-process-promise').spawn;
const admin = require('firebase-admin');
const nodeTwitterApi = require("node-twitter-api");
const adminSdkPrivateKey = require('./diggity-development-firebase-adminsdk-private-key.json');
const socialConfig = require('./social-config.json');
const request = require('request');
const cors = require('cors')({ origin: true });
// [END import]

const firebaseConfig = functions.config().firebase;
firebaseConfig.credential = admin.credential.cert(adminSdkPrivateKey);
admin.initializeApp(firebaseConfig);

// [START generateThumbnail]
/**
 * When an image is uploaded in the Storage bucket We generate a thumbnail automatically using
 * ImageMagick.
 */
// [START generateThumbnailTrigger]
exports.generateThumbnail = functions.storage.object().onChange(event => {
    // [END generateThumbnailTrigger]
    // [START eventAttributes]
    const object = event.data; // The Storage object.

    const fileBucket = object.bucket; // The Storage bucket that contains the file.
    const filePath = object.name; // File path in the bucket.
    const contentType = object.contentType; // File content type.
    console.log("File Content Type: " + contentType);

    // Declare default file extension.
    let fileExtn = ".png";

    // Check content type to set file extension.
    if (contentType) {
        switch (contentType.toLowerCase()) {
            case "image/png":
                fileExtn = ".png"
                break;

            case "image/bmp":
                fileExtn = ".bmp"
                break;

            case "image/gif":
                fileExtn = ".gif"
                break;

            case "image/jpeg":
            case "image/jpg":
                fileExtn = ".jpg"
                break;

            case "image/tiff":
            case "image/x-tiff":
                fileExtn = ".tiff"
                break;
        }
    }
    const resourceState = object.resourceState; // The resourceState is 'exists' or 'not_exists' (for file/folder deletions).
    // [END eventAttributes]

    // [START stopConditions]
    // Exit if this is triggered on a file that is not an image.
    if (!contentType.startsWith('image/')) {
        console.log('This is not an image.');
        return;
    }

    // Get the file name.
    const fileName = filePath.split('/').pop();
    // Exit if the image is already a thumbnail.
    if (fileName.startsWith('thumb_')) {
        console.log('Already a Thumbnail.');
        return;
    }

    // Exit if this is a move or deletion event.
    if (resourceState === 'not_exists') {
        console.log('This is a deletion event.');
        return;
    }
    // [END stopConditions]

    // [START thumbnailGeneration]
    // Download file from bucket.
    const bucket = gcs.bucket(fileBucket);
    const tempFilePath = `/tmp/${fileName}.${fileExtn}`;
    return bucket.file(filePath).download({
        destination: tempFilePath
    }).then(() => {
        console.log('Image downloaded locally to', tempFilePath);

        // Generate a thumbnail using ImageMagick.

        // 200x200 
        spawn('convert', [tempFilePath, '-thumbnail', '200x200>', tempFilePath]).then(() => {
            console.log('Thumbnail created at', tempFilePath);
            // We add a 'thumb_' prefix to thumbnails file name. That's where we'll upload the thumbnail.
            const thumbFilePath = fileName + '/' + filePath.replace(/(\/)?([^\/]*)$/, `$1thumb_$2_200_200`);
            // Uploading the thumbnail.
            return bucket.upload(tempFilePath, {
                destination: thumbFilePath
            });
        });

        // 400x400 
        spawn('convert', [tempFilePath, '-thumbnail', '400x400>', tempFilePath]).then(() => {
            console.log('Thumbnail created at', tempFilePath);
            // We add a 'thumb_' prefix to thumbnails file name. That's where we'll upload the thumbnail.
            const thumbFilePath = fileName + '/' + filePath.replace(/(\/)?([^\/]*)$/, `$1thumb_$2_400_400`);
            // Uploading the thumbnail.
            return bucket.upload(tempFilePath, {
                destination: thumbFilePath
            });
        });

        // 600x600 
        return spawn('convert', [tempFilePath, '-thumbnail', '600x600>', tempFilePath]).then(() => {
            console.log('Thumbnail created at', tempFilePath);
            // We add a 'thumb_' prefix to thumbnails file name. That's where we'll upload the thumbnail.
            const thumbFilePath = fileName + '/' + filePath.replace(/(\/)?([^\/]*)$/, `$1thumb_$2_600_600`);
            // Uploading the thumbnail.
            return bucket.upload(tempFilePath, {
                destination: thumbFilePath
            });
        });
    });
    // [END thumbnailGeneration]
});
// [END generateThumbnail]

// [START handleSocialLogin]
/**
 * Handle Social login using Facebook, Google, Instagram & Twitter.
 */
// [START handleSocialLoginTrigger]
exports.handleSocialLogin = functions.https.onRequest((req, res) => {
    cors(req, res, () => {
        if (req && req.query && req.query.client_id && req.query.redirect_uri && req.query.redirect_uri === socialConfig.redirectUrl) {
            let twitterApi = new nodeTwitterApi({
                consumerKey: socialConfig.twitter.consumerKey,
                consumerSecret: socialConfig.twitter.consumerSecret,
                callback: socialConfig.redirectUrl
            });

            twitterApi.getRequestToken(function(error, requestToken, requestSecret) {
                if (!error && requestToken && requestSecret) {
                    let updates = {};
                    updates[`/twitterRequestTokenSecrets/${req.query.client_id}`] = requestSecret;
                    admin.database().ref().update(updates).then(() => {
                        res.redirect(`https://api.twitter.com/oauth/authenticate?oauth_token=${requestToken}`);
                    }).catch(() => {
                        console.log("Unable to save Twitter RequestTokenSecret");
                        res.redirect(socialConfig.redirectUrl);
                    });
                } else {
                    console.log("Error fetching Twitter Request Token:", error);
                    res.redirect(socialConfig.redirectUrl);
                }
            });
        } else if (req && req.query && (req.query.provider && (req.query.provider === "facebook" || req.query.provider === "google" || req.query.provider === "instagram" || req.query.provider === "twitter")) && req.query.code) {
            let islinking = req.query.uid ? true : false;

            let promiseFirebaseUserRecordForLinking = Promise.resolve({});
            if (islinking) {
                promiseFirebaseUserRecordForLinking = admin.auth().getUser(req.query.uid).then((userRecord) => {
                    if (userRecord) {
                        return Promise.resolve(userRecord);
                    } else {
                        return Promise.resolve(null);
                    }
                }).catch(() => {
                    return Promise.resolve(null);
                });
            }
            promiseFirebaseUserRecordForLinking.then(firebaseUserRecordForLinking => {
                if (firebaseUserRecordForLinking) {
                    let socialLoginHandle = function(socialAccessToken, socialUserId, socialUserEmail, socialUserName, socialUserProfilePictureUrl, socialAccessSecret) {
                        admin.database().ref(`/socialIdentities/${req.query.provider}/${socialUserId}`).once("value").then(function (snapshot) {
                            let socialIdentity = snapshot.val();
                            if (islinking && socialIdentity) {
                                res.status(200).send({ socialUserAlreadyExists: true });
                            } else {
                                let promiseFirebaseUserRecordByEmail = Promise.resolve(null);
                                if (!islinking && !socialIdentity && socialUserEmail) {
                                    promiseFirebaseUserRecordByEmail = admin.auth().getUserByEmail(socialUserEmail).then((userRecord) => {
                                        if (userRecord) {
                                            return Promise.resolve(userRecord);
                                        } else {
                                            return Promise.resolve(null);
                                        }
                                    }).catch(() => {
                                        return Promise.resolve(null);
                                    });
                                }
                                promiseFirebaseUserRecordByEmail.then(firebaseUserRecordByEmail => {
                                    if (firebaseUserRecordByEmail) {
                                        admin.database().ref(`/userSocialIdentities/${firebaseUserRecordByEmail.uid}`).once("value").then(function (snapshot) {
                                            let firebaseUserSocialIdentities = snapshot.val();

                                            let socialProviders = [];
                                            for(let provider in firebaseUserSocialIdentities) {
                                                socialProviders.push(provider);
                                            }

                                            res.status(200).send({
                                                emailAlreadyExists: true,
                                                email: socialUserEmail,
                                                socialProviders: socialProviders,
                                                socialUser: {
                                                    provider: req.query.provider,
                                                    id: socialUserId,
                                                    accessToken: socialAccessToken,
                                                    accessSecret: socialAccessSecret
                                                }
                                            });
                                        }).catch(() => {
                                            res.status(200).send({ error: true });
                                        });
                                    } else {
                                        let firebaseUserId = (islinking ? req.query.uid : (socialIdentity && socialIdentity.firebaseUserId ? socialIdentity.firebaseUserId : `${req.query.provider}UserId::${socialUserId}`));

                                        let updates = {};
                                        updates[`/socialIdentities/${req.query.provider}/${socialUserId}`] = {
                                            accessToken: socialAccessToken,
                                            firebaseUserId: firebaseUserId
                                        };
                                        if (socialAccessSecret) {
                                            updates[`/socialIdentities/${req.query.provider}/${socialUserId}`].accessSecret = socialAccessSecret;
                                        }
                                        updates[`/userSocialIdentities/${firebaseUserId}/${req.query.provider}`] = {
                                            userId: socialUserId
                                        };

                                        admin.database().ref().update(updates).then(() => {
                                            let isUpdatedUserPropertiesFound = false;
                                            let userProperties = {};

                                            if ((!firebaseUserRecordForLinking.displayName || firebaseUserRecordForLinking.displayName === "") && socialUserName) {
                                                userProperties.displayName = socialUserName;
                                                isUpdatedUserPropertiesFound = true;
                                            }
                                            if ((!firebaseUserRecordForLinking.photoURL || firebaseUserRecordForLinking.photoURL === "") && socialUserProfilePictureUrl) {
                                                userProperties.photoURL = socialUserProfilePictureUrl;
                                                isUpdatedUserPropertiesFound = true;
                                            }
                                            if (!islinking && !socialIdentity && socialUserEmail) {
                                                userProperties.email = socialUserEmail;
                                                isUpdatedUserPropertiesFound = true;
                                            }

                                            let promiseUpdateOrCreateFirebaseUser = Promise.resolve();
                                            if (isUpdatedUserPropertiesFound) {
                                                promiseUpdateOrCreateFirebaseUser = admin.auth().updateUser(firebaseUserId, userProperties).catch(error => {
                                                    if (!islinking && error.code === "auth/user-not-found") {
                                                        userProperties.uid = firebaseUserId;

                                                        return admin.auth().createUser(userProperties).catch(() => {
                                                            return Promise.resolve();
                                                        });
                                                    } else {
                                                        return Promise.resolve();
                                                    }
                                                });
                                            }

                                            promiseUpdateOrCreateFirebaseUser.then(() => {
                                                if (islinking) {
                                                    res.status(200).send({ islinked: true });
                                                } else {
                                                    admin.auth().createCustomToken(firebaseUserId).then((customToken) => {
                                                        res.status(200).send({ token: customToken });
                                                    }).catch(() => {
                                                        res.status(200).send({ error: true });
                                                    });
                                                }
                                            });
                                        }).catch(() => {
                                            res.status(200).send({ error: true });
                                        });
                                    }
                                });
                            }
                        }).catch(() => {
                            res.status(200).send({ error: true });
                        });
                    };

                    if (req.query.provider === "twitter") {
                        let isQueryCodeParseable = true;
                        try {
                            req.query.code = JSON.parse(req.query.code);
                        } catch (e) {
                            console.log("Code is not parsable:", {
                                query: req.query,
                                parseError: e
                            });
                            isQueryCodeParseable = false;
                        }
                        if (isQueryCodeParseable) {
                            if (req.query.client_id) {
                                admin.database().ref(`/twitterRequestTokenSecrets/${req.query.client_id}`).once("value").then(function (snapshot) {
                                    let twitterRequestTokenSecret = snapshot.val();
                                    if (twitterRequestTokenSecret) {
                                        let updates = {};
                                        updates[`/twitterRequestTokenSecrets/${req.query.client_id}`] = null;
                                        let promiseRemoveTwitterRequestTokenSecret = admin.database().ref().update(updates).then(() => {
                                        }).catch(() => {
                                            console.log("Unable to remove Twitter RequestTokenSecret");
                                        });
                                        promiseRemoveTwitterRequestTokenSecret.then(() => {
                                            if (req.query.code.oauth_token && req.query.code.oauth_verifier) {
                                                let twitterApi = new nodeTwitterApi({
                                                    consumerKey: socialConfig.twitter.consumerKey,
                                                    consumerSecret: socialConfig.twitter.consumerSecret,
                                                    callback: socialConfig.redirectUrl
                                                });

                                                twitterApi.getAccessToken(req.query.code.oauth_token, twitterRequestTokenSecret, req.query.code.oauth_verifier, function(error, accessToken, accessSecret) {
                                                    if (!error && accessToken && accessSecret) {
                                                        twitterApi.verifyCredentials(accessToken, accessSecret, {include_email: true}, function(error, twitterUser) {
                                                            if (!error && twitterUser && twitterUser.id) {
                                                                let socialUserEmail;
                                                                let socialUserName;
                                                                let socialUserProfilePictureUrl;

                                                                if (twitterUser.email) {
                                                                    socialUserEmail = twitterUser.email;
                                                                }

                                                                if (twitterUser.name) {
                                                                    socialUserName = twitterUser.name;
                                                                }

                                                                if (twitterUser.profile_image_url) {
                                                                    socialUserProfilePictureUrl = twitterUser.profile_image_url;
                                                                } else if (twitterUser.profile_image_url_https) {
                                                                    socialUserProfilePictureUrl = twitterUser.profile_image_url_https;
                                                                }
                                                                socialLoginHandle(accessToken, twitterUser.id, socialUserEmail, socialUserName, socialUserProfilePictureUrl, accessSecret);
                                                            } else {
                                                                console.log("Error verifying Twitter Access Token:", error);
                                                                res.status(200).send({ error: true });
                                                            }
                                                        });
                                                    } else {
                                                        console.log("Error fetching Twitter Access Token:", error);
                                                        res.status(200).send({ error: true });
                                                    }
                                                });
                                            } else {
                                                res.status(200).send({ error: true });
                                            }
                                        });
                                    } else {
                                        console.log("Unable to retrieve Twitter RequestTokenSecret");
                                        res.status(200).send({ error: true });
                                    }
                                }).catch(() => {
                                    console.log("Unable to retrieve Twitter RequestTokenSecret");
                                    res.status(200).send({ error: true });
                                });
                            } else {
                                res.status(200).send({ error: true });
                            }
                        } else {
                            res.status(200).send({ error: true });
                        }
                    } else {
                        let postData;
                        if (req.query.provider === "facebook") {
                            postData = {
                                url: socialConfig.facebook.oAuthUrl,
                                form: {
                                    client_id: socialConfig.facebook.clientId,
                                    client_secret: socialConfig.facebook.clientSecret,
                                    grant_type: socialConfig.grantType,
                                    redirect_uri: socialConfig.redirectUrl,
                                    code: req.query.code
                                }
                            };
                        } else if (req.query.provider === "google") {
                            postData = {
                                url: socialConfig.google.oAuthUrl,
                                form: {
                                    client_id: socialConfig.google.clientId,
                                    client_secret: socialConfig.google.clientSecret,
                                    grant_type: socialConfig.grantType,
                                    redirect_uri: socialConfig.redirectUrl,
                                    code: req.query.code
                                }
                            };
                        } else if (req.query.provider === "instagram") {
                            postData = {
                                url: socialConfig.instagram.oAuthUrl,
                                form: {
                                    client_id: socialConfig.instagram.clientId,
                                    client_secret: socialConfig.instagram.clientSecret,
                                    grant_type: socialConfig.grantType,
                                    redirect_uri: socialConfig.redirectUrl,
                                    code: req.query.code
                                }
                            };
                        }
                        request.post(postData, function (error, response, body) {
                            let isPostBodyParseable = true;
                            try {
                                body = JSON.parse(body);
                            } catch (e) {
                                console.log("Token Response body is not parsable:", {
                                    query: req.query,
                                    postData: postData,
                                    error: error,
                                    response: response,
                                    body: body,
                                    parseError: e
                                });
                                isPostBodyParseable = false;
                            }
                            if (isPostBodyParseable) {
                                if (!error && response && response.statusCode === 200 && body && body.access_token) {
                                    let socialAccessToken = body.access_token;

                                    let getData;
                                    if (req.query.provider === "facebook") {
                                        getData = {
                                            url: `https://graph.facebook.com/v2.9/me?fields=id,email,name,picture&access_token=${socialAccessToken}`
                                        };
                                    } else if (req.query.provider === "google") {
                                        getData = {
                                            url: `https://www.googleapis.com/oauth2/v1/userinfo?access_token=${socialAccessToken}`
                                        };
                                    } else if (req.query.provider === "instagram") {
                                        getData = {
                                            url: `https://api.instagram.com/v1/users/self?access_token=${socialAccessToken}`
                                        };
                                    }
                                    request.get(getData, function (error, response, body) {
                                        let isGetBodyParseable = true;
                                        try {
                                            body = JSON.parse(body);
                                        } catch (e) {
                                            console.log("Profile Response body is not parsable:", {
                                                query: req.query,
                                                getData: getData,
                                                error: error,
                                                response: response,
                                                body: body,
                                                parseError: e
                                            });
                                            isGetBodyParseable = false;
                                        }
                                        if (isGetBodyParseable) {
                                            if (!error && response && response.statusCode === 200 && ((req.query.provider === "facebook" && body.id) || (req.query.provider === "google" && body.id) || (req.query.provider === "instagram" && body.data && body.data.id))) {
                                                let socialUserId;
                                                let socialUserEmail;
                                                let socialUserName;
                                                let socialUserProfilePictureUrl;

                                                if (req.query.provider === "facebook") {
                                                    socialUserId = body.id;
                                                    if (body.email) socialUserEmail = body.email;
                                                    if (body.name) socialUserName = body.name;
                                                    if (body.picture && body.picture.data && body.picture.data.url) socialUserProfilePictureUrl = body.picture.data.url;
                                                } else if (req.query.provider === "google") {
                                                    socialUserId = body.id;
                                                    if (body.email) socialUserEmail = body.email;
                                                    if (body.name) socialUserName = body.name;
                                                    if (body.picture) socialUserProfilePictureUrl = body.picture;
                                                } else if (req.query.provider === "instagram") {
                                                    socialUserId = body.data.id;
                                                    if (body.data.full_name) socialUserName = body.data.full_name;
                                                    if (body.data.profile_picture) socialUserProfilePictureUrl = body.data.profile_picture;
                                                }
                                                
                                                socialLoginHandle(socialAccessToken, socialUserId, socialUserEmail, socialUserName, socialUserProfilePictureUrl);
                                            } else {
                                                console.log("Unexpected Profile response:", {
                                                    query: req.query,
                                                    getData: getData,
                                                    error: error,
                                                    response: response,
                                                    body: body
                                                });
                                                res.status(200).send({ error: true });
                                            }
                                        } else {
                                            res.status(200).send({ error: true });
                                        }
                                    });
                                } else {
                                    console.log("Unexpected Token Response:", {
                                        query: req.query,
                                        postData: postData,
                                        error: error,
                                        response: response,
                                        body: body
                                    });
                                    if (body && ((body.error && body.error.message) || body.error_description || body.error_message)) {
                                        res.status(200).send({ message: (body.error_description || body.error_message || body.error.message) });
                                    } else {
                                        res.status(200).send({ error: true });
                                    }
                                }
                            } else {
                                res.status(200).send({ error: true });
                            }
                        });
                    }
                } else {
                    console.log("Unable to find firebase user to link in request:", req.query);
                    res.status(200).send({ error: true });
                }
            });
        } else {
            console.log("Error in request:", req.query);
            res.status(200).send({ error: true });
        }
    });
});
// [END handleSocialLoginTrigger]
// [END handleSocialLogin]








// [START handleInstagramLogin]
/**
 * Handle Instagram login.
 */
// [START handleInstagramLoginTrigger]
exports.handleInstagramLogin = functions.https.onRequest((req, res) => {
    cors(req, res, () => {
        if (req && req.query && req.query.code) {
            let islinking = req.query.uid ? true : false;

            let promiseFirebaseUserRecordForLinking = Promise.resolve({});
            if (islinking) {
                promiseFirebaseUserRecordForLinking = admin.auth().getUser(req.query.uid).then((userRecord) => {
                    if (userRecord) {
                        return Promise.resolve(userRecord);
                    } else {
                        return Promise.resolve(null);
                    }
                }).catch(() => {
                    return Promise.resolve(null);
                });
            }
            promiseFirebaseUserRecordForLinking.then(firebaseUserRecordForLinking => {
                if (firebaseUserRecordForLinking) {
                    let instagramAuthCode = req.query.code;

                    request.post({
                        url: socialConfig.instagram.oAuthUrl,
                        form: {
                            client_id: socialConfig.instagram.clientId,
                            client_secret: socialConfig.instagram.clientSecret,
                            grant_type: "authorization_code",
                            redirect_uri: socialConfig.redirectUrl,
                            code: instagramAuthCode
                        }
                    }, function (error, response, body) {
                        let isBodyParseable = true;

                        try {
                            body = JSON.parse(body);
                        } catch (e) {
                            isBodyParseable = false;
                        }

                        if (isBodyParseable) {
                            if (!error && response && response.statusCode === 200 && body && body.access_token && body.user && body.user.id) {
                                let instagramUserId = body.user.id;

                                admin.database().ref("/instagramIdentities/" + instagramUserId).once("value").then(function (snapshot) {
                                    let instagramIdentity = snapshot.val();

                                    if (islinking && instagramIdentity) {
                                        res.status(200).send({ instagramUserAlreadyExists: true });
                                    } else {
                                        let firebaseUserId = (islinking ? req.query.uid : (instagramIdentity && instagramIdentity.firebaseUserId ? instagramIdentity.firebaseUserId : "instagramUserId::" + instagramUserId));

                                        let updates = {};
                                        updates["/instagramIdentities/" + instagramUserId] = {
                                            accessToken: body.access_token,
                                            firebaseUserId: firebaseUserId,
                                            user: body.user
                                        };
                                        updates["/userInstagramIdentities/" + firebaseUserId] = {
                                            instagramUserId: instagramUserId
                                        };

                                        admin.database().ref().update(updates).then(() => {
                                            let isUserPropertiesFound = false;
                                            let userProperties = {};

                                            if ((!firebaseUserRecordForLinking.displayName || firebaseUserRecordForLinking.displayName === "") && body.user.full_name) {
                                                userProperties.displayName = body.user.full_name;
                                                isUserPropertiesFound = true;
                                            }
                                            if ((!firebaseUserRecordForLinking.photoURL || firebaseUserRecordForLinking.photoURL === "") && body.user.profile_picture) {
                                                userProperties.photoURL = body.user.profile_picture;
                                                isUserPropertiesFound = true;
                                            }

                                            let promiseUpdateOrCreateFirebaseUser = Promise.resolve();
                                            if (isUserPropertiesFound) {
                                                promiseUpdateOrCreateFirebaseUser = admin.auth().updateUser(firebaseUserId, userProperties).catch(error => {
                                                    if (!islinking && error.code === "auth/user-not-found") {
                                                        userProperties.uid = firebaseUserId;

                                                        return admin.auth().createUser(userProperties).catch(() => {
                                                            return Promise.resolve();
                                                        });
                                                    } else {
                                                        return Promise.resolve();
                                                    }
                                                });
                                            }

                                            promiseUpdateOrCreateFirebaseUser.then(() => {
                                                if (islinking) {
                                                    res.status(200).send({ islinked: true });
                                                } else {
                                                    admin.auth().createCustomToken(firebaseUserId).then((customToken) => {
                                                        res.status(200).send({ token: customToken });
                                                    }).catch(() => {
                                                        res.status(200).send({ error: true });
                                                    });
                                                }
                                            });
                                        }).catch(() => {
                                            res.status(200).send({ error: true });
                                        });
                                    }
                                }).catch(() => {
                                    res.status(200).send({ error: true });
                                });
                            } else if (body && body.error_message) {
                                res.status(200).send({ message: body.error_message });
                            } else {
                                res.status(200).send({ error: true });
                            }
                        } else {
                            res.status(200).send({ error: true });
                        }
                    });
                } else {
                    res.status(200).send({ error: true });
                }
            });
        } else {
            res.status(200).send({ error: true });
        }
    });
});
// [END handleInstagramLoginTrigger]
// [END handleInstagramLogin]
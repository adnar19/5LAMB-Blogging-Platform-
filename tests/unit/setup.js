// Variables d'environnement lues par src/lib/config.js et identifiants factices pour les URL presignees.
process.env.POSTS_TABLE = 'posts-test';
process.env.COMMENTS_TABLE = 'comments-test';
process.env.MEDIA_TABLE = 'media-test';
process.env.SEARCH_TABLE = 'search-test';
process.env.MEDIA_BUCKET = 'media-bucket-test';
process.env.USER_POOL_ID = 'eu-north-1_TEST';
process.env.USER_POOL_CLIENT_ID = 'client-test';
process.env.NEW_POST_TOPIC_ARN = 'arn:aws:sns:eu-north-1:123456789012:new-post-test';
process.env.SITE_URL = 'https://blog.example.test';
process.env.LOG_LEVEL = 'silent';
process.env.AWS_REGION = 'eu-north-1';
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';

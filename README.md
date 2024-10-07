**[Demo](https://img.gwwc.net)**
# 功能说明

该图床实现了以下主要几点功能：

1.  文件格式和大小限制
2.  根据上传者的IP限制速率
3.  一个简易的查询数据库的API接口
4.  一个简易的历史记录界面，在本地存储你上传过的所有图片，并可删除图片及CloudFlare的边缘缓存

# 搭建所需要使用到的服务

1.  一个CloudFlare账号
2.  一个CloudFlare R2标准存储桶服务
3.  一个Workres或者Pages服务
4.  一个D1数据库 以上服务均可在[CloudFlare 客户首页](https://dash.cloudflare.com/)界面中找到并开启
5.  一个可有可无的域名（不用自己的域名删除不了边缘缓存)

# 要花钱的地方

1.  CloudFlare R2存储桶服务 这个免费额度是每月10GB的存储，一百万次的A操作（写入，删除之类的操作），一千万次的B操作（读取图片之类的操作）
2.  Workers/Pages及D1数据库也有额度限制，但只要不开启收费版是不会收费的，只是不能使用。Workers/Pages使用自定义域可以不受每天十万次请求的限制

## Workers系列的免费额度

![img](https://img.gwwc.net/up/2024/10/05/qs4dmv.png)

## R2超出后的收费

![img](https://img.gwwc.net/up/2024/10/05/5sj643.png)

# 部署

## 使用Workers部署

1.  新建一个Workers项目并先部署然后设置变量

-   `ADMIN_PASSWORD`\=你的数据库查询接口密码
-   `ADMIN_PATH`\=你的数据库查询路径
-   `MAX_FILE_SIZE_MB`\=你的图床文件大小上传限制（单位：MB）
-   `DOMAIN`\=你的图床域名
-   `CLOUDFLARE_ZONE_ID`\=你的CloudFlare的域名区域ID
-   `CLOUDFLARE_EMAIL`\=你的CloudFlare邮箱账户
-   `CLOUDFLARE_API_KEY`\=你的Global API Key
-   `MAX_COUNT`=你的图床每小时上传次数最大限制

2.  绑定R2存储桶和D1数据库，变量名称分别为`img`和`D1`
3.  创建D1数据库并到控制台初始化表 初始化命令

```
CREATE TABLE uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    identifier TEXT NOT NULL UNIQUE,
    ip TEXT NOT NULL,
    upload_time DATETIME NOT NULL
);
```

3.  将本项目存储库中的`_workre.js`代码全部复制到里面并保存部署（注意修改前端代码）

---

## 使用Pages部署

1.  forks我的项目到你的GitHub并保存
2.  创建D1数据库并到控制台初始化表 初始化命令

```
CREATE TABLE uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    identifier TEXT NOT NULL UNIQUE,
    ip TEXT NOT NULL,
    upload_time DATETIME NOT NULL
);
```

3.  新建一个Pages项目并连接到你GitHub并添加刚刚的存储库
4.  绑定R2存储桶和D1数据库，变量名称分别为`img`和`D1`
5.  设置环境变量并保存部署（注意修改前端代码）

-   `ADMIN_PASSWORD`\=你的数据库查询接口密码
-   `ADMIN_PATH`\=你的数据库查询路径
-   `MAX_FILE_SIZE_MB`\=你的图床文件大小上传限制（单位：MB）
-   `DOMAIN`\=你的图床域名
-   `CLOUDFLARE_ZONE_ID`\=你的CloudFlare的域名区域ID
-   `CLOUDFLARE_EMAIL`\=你的CloudFlare邮箱账户
-   `CLOUDFLARE_API_KEY`\=你的Global API Key
-   `MAX_COUNT`=你的图床每小时上传次数最大限制

用Pages部署的话可以将前端代码和后端代码分为不同的文件部署

# 查询数据库接口的使用说明

1.  查询所有记录= `https://YOUR_DOMAIN/YOUR_ADMIN_PATH?password=YOUR_ADMIN_PASSWORD&留空或者任意字符`
2.  查询指定IP的所有上传记录数据=`https://YOUR_DOMAIN/YOUR_ADMIN_PATH?password=YOUR_ADMIN_PASSWORD&query=IP`
3.  查询文件标识符相对应数据记录=`https://YOUR_DOMAIN/YOUR_ADMIN_PATH?password=YOUR_ADMIN_PASSWORD&query=IDENTIFER`
4.  查询URL相对应的数据记录=`https://YOUR_DOMAIN/YOUR_ADMIN_PATH?password=YOUR_ADMIN_PASSWORD&query=URL`

# 本地历史记录迁移

该教程仅限于本项目。

# 迁出

1.  在浏览器中打开图床网页，按F12进入控制台，找到“应用/应用程序”选项卡并点击进入，再点击“本地存储”中的图床域名，然后打开“imageHistory”密钥所对应的值并右键“复制值”，这时历史记录中的图片链接就会到你的剪切板里了，然后随便找个地方粘贴保存，或者不保存也行 ![img](https://img.gwwc.net/up/2024/10/03/0q6ez1.png)

# 迁入

1.  迁入分两种情况，一种是增量迁入，一种是全量迁入。全量迁入适用于全新未使用过本网站的浏览器，直接按步骤到第三步那里“编辑值”并全选粘贴回车。
2.  增量迁入，增量迁入的操作是直接按步骤到第四步那里将“值”复制出来，然后将要迁入的数据追加到最后一行，然后再粘贴回去保存。

```
[
  {
    "url": "https://img.gwwc.net/up/2024/10/03/0q6ez1.png",
    "identifier": "9b96xxxx-6fea-xxxx-ae40-xxxx7bd6e681"
  }
# 去掉大框后在此处复制追加的数据，不要复制到下面那个大框外了
]
```

**觉得本项目好用的话可以点个星星支持一下**

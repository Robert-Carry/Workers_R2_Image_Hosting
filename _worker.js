export default {
    async fetch(request, env) {
        // 创建 URL 对象，用于解析请求的 URL
        const url = new URL(request.url);
        
        // 获取请求的路径
        const path = url.pathname;
        
        // 获取客户端的 IP 地址，依次从 X-Forwarded-For, CF-Connecting-IP 或 X-Real-IP 请求头中获取
        const clientIP = request.headers.get('X-Forwarded-For') || request.headers.get('CF-Connecting-IP') || request.headers.get('X-Real-IP');
        
        // 获取当前时间的时间戳
        const now = Date.now();

        // 如果请求方法是 POST 并且路径是 /upload，则调用 handleUpload 处理上传
        if (request.method === 'POST' && path === '/upload') {
            return await handleUpload(request, env, clientIP, now);

        // 如果请求方法是 DELETE 并且路径以 /delete/ 开头，则调用 handleDelete 处理删除操作
        } else if (request.method === 'DELETE' && path.startsWith('/delete/')) {
            // 从路径中提取要删除的文件标识符
            const identifier = path.split('/delete/')[1];
            return await handleDelete(request, env, identifier);

        // 如果路径是 /history，则返回历史记录的 HTML 响应
        } else if (path === '/history') {           
            return new Response(buildHistoryHTML(), { headers: { 'Content-Type': 'text/html' } });

        // 如果路径是 /env.ADMIN_PATH，则调用 handleAdmin 处理管理员操作
        } else if (path === '/env.ADMIN_PATH') {
            return await handleAdmin(request, env);        

        // 如果路径不是根路径 /，则调用 handleFileRequest 处理文件请求
        } else if (path !== '/') {
            return await handleFileRequest(request, env, path);

        // 如果路径是根路径 /，则返回上传页面的 HTML 响应
        } else {
            return new Response(buildUploadHTML(), { headers: { 'Content-Type': 'text/html' } });
        }
    }
};

async function handleAdmin(request, env) {
    if (request.method === 'GET') {
        const url = new URL(request.url);
        const password = url.searchParams.get('password');
        const query = url.searchParams.get('query');

        if (password === env.ADMIN_PASSWORD) {
            const results = await queryDatabase(env, query);
            return new Response(JSON.stringify(results, null, 2), { headers: { 'Content-Type': 'application/json' } });
        } else {
            return new Response('', { status: 404 });
        }
    } else {
        return new Response('', { status: 404 });
    }
}

async function queryDatabase(env, query = null) {
    let sql = `SELECT * FROM uploads`;
    const binds = [];

    if (query) {
        sql += ` WHERE ip = ? OR url = ? OR identifier = ?`;
        binds.push(query, query, query);
    }
    
    try {
        const result = await env.D1.prepare(sql).bind(...binds).all();
        return result;
    } catch (error) {
        console.error('Error querying database:', error);
        throw error;
    }
}

async function handleUpload(request, env, clientIP, now) {
    // 一小时前的时间戳，用于查询最近一小时的上传记录
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();

    // SQL 查询，获取该 IP 在过去一小时内的上传次数
    const sql = `SELECT COUNT(*) as count FROM uploads WHERE ip = ? AND upload_time >= ?`;
    const countResult = await env.D1.prepare(sql).bind(clientIP, oneHourAgo).first();

    // 从请求中获取表单数据
    const formData = await request.formData();

    // 获取所有上传的文件（表单字段名为 'file'）
    const files = formData.getAll('file');
    const results = [];

    // 最大文件大小（从环境变量中获取，单位是 MB）
    const MAX_FILE_SIZE_BYTES = env.MAX_FILE_SIZE_MB * 1024 * 1024;

    // 遍历上传的每一个文件
    for (const file of files) {
        // 设定上传次数限制
        let uploadLimit = env.MAX_COUNT;

        // 检查当前 IP 上传次数是否超过限制
        if (countResult.count > uploadLimit) {
            return new Response('Upload limit reached. You can upload again after an hour.', { status: 429 });
        }

        // 检查文件大小是否超出最大限制
        if (file.size > MAX_FILE_SIZE_BYTES) {
            return new Response(`File size exceeds ${env.MAX_FILE_SIZE_MB}MB limit.`, { status: 413 });
        }

        // 只允许上传图片文件，其他类型文件直接跳过
        if (!file.type.startsWith('image/')) {
            continue;
        }

        // 计算文件的哈希值（通常用于去重）
        const fileHash = await hashFile(file);

        // 检查数据库中是否已经存在相同哈希值的文件
        const existingFile = await getFileFromDatabase(env, fileHash);

        // 如果文件已经存在，返回现有文件的 URL
        if (existingFile) {
            results.push({ url: existingFile.url, type: file.type });
        } else {
            // 获取文件的扩展名
            const fileExt = file.name.split('.').pop().toLowerCase();
            // 生成新的文件名
            const fileName = generateFileName(fileExt);
            // 获取文件的内容类型（如果没有提供，则使用默认的二进制流类型）
            const contentType = file.type || 'application/octet-stream';
            // 生成唯一标识符，用于标识文件
            const identifier = generateUUID();

            // 将文件存储到 img 存储系统（如 R2）
            await env.img.put(fileName, file.stream(), {
                httpMetadata: { contentType: contentType }
            });

            // 上传成功后增加上传计数
            countResult.count++;
            
            // 再次检查当前计数，确保没有超出限制（为下一次上传做准备）
            const updatedCountResult = await env.D1.prepare(sql).bind(clientIP, oneHourAgo).first();
            countResult.count = updatedCountResult.count; // 更新计数

            // 如果超过上传次数限制，返回 429 错误
            if (countResult.count >= uploadLimit) {
                return new Response('Upload limit reached. You can upload again after an hour.', { status: 429 });
            }

            // 生成文件的访问 URL
            const fileUrl = `https://${env.DOMAIN}/${fileName}`;
            
            // 将文件信息存储到数据库
            await saveToD1Database(env, fileUrl, fileHash, identifier, clientIP, now);

            // 将文件信息添加到结果列表中
            results.push({ url: fileUrl, identifier: identifier, type: file.type });
        }
    }

    // 将所有结果返回为 JSON 响应
    return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' }
    });
}

async function getFileFromDatabase(env, hash) {
    const sql = `SELECT url FROM uploads WHERE hash = ?`;
    const result = await env.D1.prepare(sql).bind(hash).first();
    return result || null;
}

async function saveToD1Database(env, url, hash, identifier, clientIP, timestamp) {
    const sql = `
        INSERT INTO uploads (url, hash, identifier, ip, upload_time)
        VALUES (?, ?, ?, ?, ?)
    `;
    const params = [url, hash, identifier, clientIP, new Date(timestamp).toISOString()];

    await env.D1.prepare(sql).bind(...params).run();
}

async function handleFileRequest(request, env, path) {
    const MAX_CACHE_SIZE_MB = 110;
    const MAX_CACHE_SIZE_BYTES = MAX_CACHE_SIZE_MB * 1024 * 1024;

    // 从全局默认缓存中获取缓存实例
    const cache = caches.default;
    
    // 为缓存创建一个唯一的 key，使用请求的 URL 作为标识符
    const cacheKey = new Request(request.url, request);
    
    // 尝试从缓存中查找是否已经存在相应的响应
    let response = await cache.match(cacheKey);

    // 如果缓存中没有找到响应
    if (!response) {
        try {
            // 从 R2 对象中获取文件
            const object = await env.img.get(path.substring(1));  // path 去掉第一个字符，例如 '/' 后面的部分
            
            // 如果 object 不存在，说明文件没找到，返回 404 错误
            if (!object) {
                const notFoundImage = await env.img.get('up/404.png');  // 尝试获取 404 图片
                if (!notFoundImage) {
                    return new Response('404', { status: 404 });  // 如果 404 图片也不存在，则返回文字 404
                }
                
                // 返回 404 图片，响应类型为 PNG
                response = new Response(notFoundImage.body, {
                    headers: { 'Content-Type': 'image/png' },
                    status: 404
                });
            } else {
                // 如果 object 存在，返回文件的主体内容
                response = new Response(object.body, {
                    headers: {
                        // 如果文件的 HTTP 元数据中有 contentType，则使用它；否则使用默认的二进制流类型
                        'Content-Type': object.httpMetadata.contentType || 'application/octet-stream',
                    }
                });

                // 如果文件大小小于最大缓存大小，则将其添加到缓存中
                if (object.size <= MAX_CACHE_SIZE_BYTES) {
                    // 设置缓存头，使得资源可以被长时间缓存
                    response.headers.append('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
                    // 将响应克隆一份放入缓存中，原响应继续返回给用户
                    await cache.put(cacheKey, response.clone());
                }
            }
        } catch (err) {
            // 捕获可能的异常，返回 500 错误，表示服务器内部错误
            return new Response('Error getting file', { status: 500 });
        }
    }
    
    // 如果缓存中有响应或者已经获取到了文件内容，返回该响应
    return response;
};

async function hashFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

function generateFileName(ext) {
    const date = new Date();
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const randomString = Math.random().toString(36).substring(2, 8);
    return `up/${year}/${month}/${day}/${randomString}.${ext}`; // 路径及文件名的生成方式：UTC时间的年/月/日/随机六位字符串.文件扩展名
}

async function handleDelete(request, env, identifier) {
    try {
        const sql = `SELECT url FROM uploads WHERE identifier = ?`;
        const result = await env.D1.prepare(sql).bind(identifier).first();

        if (!result) {
            return new Response('Invalid identifier', { status: 404 });
        }

        const fileName = result.url.replace(/^https?:\/\/[^\/]+/, '').substring(1);

        await env.img.delete(fileName); // 删除文件

        const deleteSql = `DELETE FROM uploads WHERE identifier = ?`;
        await env.D1.prepare(deleteSql).bind(identifier).run(); // 删除数据库记录

        await purgeCache(env, `https://${env.DOMAIN}/${fileName}`); // 删除CloudFlare边缘缓存

        return new Response('File deleted successfully', { status: 200 });
    } catch (error) {
        return new Response('Error deleting file', { status: 500 });
    }
}

async function purgeCache(env, fileUrl) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/purge_cache`, {
        method: 'POST',
        headers: {
            'X-Auth-Key': env.CLOUDFLARE_API_KEY,
            'X-Auth-Email': env.CLOUDFLARE_EMAIL,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            files: [fileUrl]
        }),
    });

    if (!response.ok) {
        throw new Error(`Failed to purge cache: ${response.statusText}`);
    }
    
    return await response.json();
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function buildUploadHTML() {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Image hosting</title>
          <style> 
          body {
            font-family: Arial, sans-serif;
            background-color: #f3f4f6;
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            position: relative;
        }
        h1 {
            color: #333;
            margin-top: 20px;
            cursor: pointer;
        }
        #upload-container {
            background-color: #ffffff;
            padding: 20px;
            margin-top: 20px;
            border-radius: 8px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
            width: 60%;
            text-align: center;
        }
        #dropzone {
            border: 2px dashed #ccc;
            border-radius: 8px;
            padding: 20px;
            cursor: pointer;
            margin-bottom: 20px;
            position: relative;
            height: 200px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #dropzone.active {
            border-color: #007bff;
            background-color: #f0f8ff;
        }
        #file-input {
            position: absolute;
            width: 100%;
            height: 100%;
            opacity: 0;
            cursor: pointer;
        }
        #preview-container {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 20px;
            justify-content: center;
        }
        .preview-item {
            position: relative;
            width: 120px;
            height: 140px;
            background-color: #f0f0f0;
            border: 1px solid #cccccc;
            border-radius: 8px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 10px;            
        }

        .preview-item img {
            display: block;
            margin: 0 auto;
            max-width: 100px;
            max-height: 100px;
            border-radius: 8px;
            cursor: pointer;
            margin-bottom: 5px;
        }    
        .copy-button {
            padding: 5px 10px;
            background-color: #d8d8d8;
            color: #333333;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 12px;
            margin-top: 5px;
        }
        .copy-button:hover {
            background-color: #007bff;
        }
        .image-modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            justify-content: center;
            align-items: center;
        }
        .image-modal img {
            max-width: 90%;
            max-height: 90%;
            border-radius: 8px;
        }
        .image-modal.active {
            display: flex;
        }
        .image-modal .close-button {
            position: absolute;
            top: 20px;
            right: 20px;
            background: rgba(255, 255, 255, 0.8);
            border: none;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            cursor: pointer;
            font-size: 20px;
            text-align: center;
            line-height: 40px;
        }
        #history-button {
            position: absolute;
            top: 25px;
            right: 20px;
            padding: 5px 10px;
            background: none;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
        }
        .toast {
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background-color: #fefefe;
            color: #333;
            padding: 10px 20px;
            border-radius: 5px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            display: none;
            z-index: 1000;
            font-size: 16px;
            opacity: 0;
            transition: opacity 0.3s ease;
        }
        .toast.show {
            opacity: 1;
        } 
        @media (max-width: 600px) {
        #upload-container {
            width: 95%;
            padding: 10px;
        }  
        .preview-item {
            max-width: 100px;
            max-height: 120px;          
        }
        
        .preview-item img {
            max-width: 80px;
            max-height: 90px;
        }            
        .copy-button {
            font-size: 10px;   
        }         
          </style> 
      </head> 
      <body> 
          <h1 id="page-title">Image hosting</h1> 
          <button id="history-button" class="history-button">
          <svg xmlns="http://www.w3.org/2000/svg" fill="#888" viewBox="0 0 24 24" style="width: 20px; height: 20px; margin-right: 5px;">
            <path d="M12 0C5.372 0 0 5.372 0 12c0 6.628 5.372 12 12 12 6.628 0 12-5.372 12-12S18.628 0 12 0zm0 22c-5.52 0-10-4.48-10-10S6.48 2 12 2s10 4.48 10 10-4.48 10-10 10zm-1-15h-2v6h8v-2h-6zm1 10c-1.104 0-2 .896-2 2h2c0-1.104-.896-2-2-2z"/>
          </svg>
          </button>
          <div id="upload-container"> 
              <div id="dropzone"> 
                  <span>✛</span>                   
                  <input type="file" id="file-input" name="file" multiple accept="image/*">  // 选择文件格式限制
              </div> 
          </div> 
   
          <div id="preview-container"></div> 
   
          <div id="file-modal" class="image-modal"> 
              <button class="close-button">&times;</button> 
              <img id="modal-file" src="" alt="IMG"> 
          </div> 
   
          <div id="toast" class="toast"></div> 
 
          <footer style="background-color: #f0f0f0; padding: 10px; text-align: center; font-size: 14px; position: fixed; bottom: 0; width: 100%;"> 
          <p style="margin: 0;"> 
              &copy; 2024 GWWC. All rights reserved. <a href="https://github.com/Robert-Carry/Workers_R2_Image_Hosting" style="color: inherit; text-decoration: none;">GitHub</a> 
          </p> 
          </footer>        
          <script> 
          const modal = document.getElementById('file-modal'); 
          const modalFile = document.getElementById('modal-file'); 
          const closeButton = document.querySelector('.close-button'); 
          const dropzone = document.getElementById('dropzone'); 
          const fileInput = document.getElementById('file-input'); 
          const previewContainer = document.getElementById('preview-container'); 
          const historyButton = document.getElementById('history-button'); 
          const toast = document.getElementById('toast'); 
 
          document.getElementById('page-title').addEventListener('click', () => { 
              window.location.reload(); 
          }); 
 
          dropzone.addEventListener('dragover', (e) => { 
              e.preventDefault(); 
              dropzone.classList.add('active'); 
          }); 
   
          dropzone.addEventListener('dragleave', () => { 
              dropzone.classList.remove('active'); 
          }); 
   
          dropzone.addEventListener('drop', async (e) => { 
              e.preventDefault(); 
              dropzone.classList.remove('active'); 
              const files = Array.from(e.dataTransfer.files); 
              await uploadFiles(files); 
          }); 
   
          fileInput.addEventListener('change', async () => { 
              const files = Array.from(fileInput.files); 
              await uploadFiles(files); 
          }); 

          async function uploadFiles(files) { 
            for (const file of files) { 
                if (!file.type.startsWith('image/')) continue; 

                // 前端限制上传文件大小限制的代码，需对应后端限制大小
                if (file.size > 30 * 1024 * 1024) {
                    showToast('The file size exceeds the limit 30MB!');
                    continue;
                }        
        
                const formData = new FormData(); 
                formData.append('file', file); 
        
                const xhr = new XMLHttpRequest(); 
                xhr.open('POST', '/upload');
        
                const previewItem = document.createElement('div'); 
                previewItem.classList.add('preview-item'); 
                previewContainer.appendChild(previewItem); 
        
                const progressBarContainer = document.createElement('div');
                progressBarContainer.classList.add('progress-bar-container');
                progressBarContainer.style.position = 'relative';
                progressBarContainer.style.width = '100%';
                progressBarContainer.style.height = '10px';
                progressBarContainer.style.backgroundColor = '#f0f0f0';
                progressBarContainer.style.marginTop = '10px';
        
                const progressBar = document.createElement('div');
                progressBar.classList.add('progress-bar');
                progressBar.style.height = '100%';
                progressBar.style.width = '0%';
                progressBar.style.backgroundColor = '#4caf50';
                progressBarContainer.appendChild(progressBar);
        
                previewItem.appendChild(progressBarContainer);
        
                xhr.upload.onprogress = (event) => {
                    if (event.lengthComputable) {
                        const percentComplete = (event.loaded / event.total) * 100;
                        progressBar.style.width = percentComplete + '%';
                    }
                };
        
                xhr.onload = async () => { 
                    if (xhr.status === 200) { 
                        const result = JSON.parse(xhr.responseText); 
                        result.forEach(file => { 
                            const img = document.createElement('img'); 
                            img.src = file.url; 
                            img.alt = 'IMG'; 
                            img.onload = () => img.style.display = 'block'; 
                            img.onerror = () => img.style.display = 'none'; 
                            img.onclick = () => { 
                                modalFile.src = file.url; 
                                modal.classList.add('active'); 
                            }; 
                            previewItem.appendChild(img); 
        
                            const buttonContainer = document.createElement('div');
                            buttonContainer.style.display = 'flex';
                            buttonContainer.style.gap = '5px';
                            buttonContainer.style.position = 'absolute';
                            buttonContainer.style.bottom = '0';
        
                            const copyButton = document.createElement('button');
                            copyButton.classList.add('copy-button');
                            copyButton.textContent = 'URL';
                            copyButton.onclick = () => {
                                navigator.clipboard.writeText(file.url).then(() => {
                                    showToast('Link copied!');
                                });
                            };
        
                            const copyMdButton = document.createElement('button');
                            copyMdButton.classList.add('copy-button');
                            copyMdButton.textContent = 'MD';
                            copyMdButton.onclick = () => {
                                const markdownLink = '![img](' + file.url + ')';
                                navigator.clipboard.writeText(markdownLink).then(() => {
                                    showToast('Markdown link copied!');
                                });
                            };
        
                            const copyBBCButton = document.createElement('button');
                            copyBBCButton.classList.add('copy-button');
                            copyBBCButton.textContent = 'BBC';
                            copyBBCButton.onclick = () => {
                                const bbcodeLink = '[img]' + file.url + '[/img]';
                                navigator.clipboard.writeText(bbcodeLink).then(() => {
                                    showToast('BBCode link copied!');
                                });
                            };                            
        
                            buttonContainer.appendChild(copyButton);
                            buttonContainer.appendChild(copyMdButton);
                            buttonContainer.appendChild(copyBBCButton);
                            previewItem.appendChild(buttonContainer);
        
                            saveToHistory(file.url, file.identifier); 
                        }); 
        
                            progressBarContainer.remove();
                            
                    } else if (xhr.status === 429) { 
                        progressBar.style.backgroundColor = '#f44336'; 
                        showToast('Your upload limit has been reached. You can upload again in one hour.'); 
                    } else { 
                        progressBar.style.backgroundColor = '#f44336'; 
                        showToast('Error uploading file.'); 
                    } 
                }; 
        
                xhr.send(formData); 
            } 
        }  
 
        function saveToHistory(url, identifier) { 
            let history = JSON.parse(localStorage.getItem('imageHistory')) || []; 
            if (!history.some(item => item.url === url)) { 
                history.push({ url: url, identifier: identifier }); 
                localStorage.setItem('imageHistory', JSON.stringify(history)); 
            } 
        }
   
          historyButton.addEventListener('click', () => { 
              window.location.href = '/history'; 
          }); 
   
          closeButton.addEventListener('click', () => { 
              modal.classList.remove('active'); 
          }); 
   
          window.addEventListener('click', (e) => { 
              if (e.target === modal) { 
                  modal.classList.remove('active'); 
              } 
          }); 
   
          window.addEventListener('paste', async (e) => { 
              if (e.clipboardData && e.clipboardData.items) { 
                  const items = e.clipboardData.items; 
                  for (const item of items) { 
                      if (item.kind === 'file' && item.type.startsWith('image/')) { 
                          const file = item.getAsFile(); 
                          await uploadFiles([file]); 
                      } 
                  } 
              } 
          }); 
   
          function showToast(message) { 
            const toast = document.getElementById('toast'); 
            toast.textContent = message; 
            toast.classList.add('show'); 
            toast.style.display = 'block'; 
            setTimeout(() => { 
                toast.classList.remove('show'); 
                setTimeout(() => { 
                    toast.style.display = 'none'; 
                }, 500);  
            }, 2000); 
        }       
          </script> 
      </body> 
      </html> 
      `; 
  }
  
function buildHistoryHTML() {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>      
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>History</title>
        <style>
        body {
            font-family: Arial, sans-serif;
            background-color: #f3f4f6;
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
        }
        h1 {
            color: #333;
            margin-top: 20px;
        }
        #history-container {
            display: grid;
            gap: 10px;
            margin-top: 20px;
            justify-content: center;
            padding: 0 10px;
        }        
        .history-item {
            position: relative;
            width: 120px;
            height: 140px;
            background-color: #f0f0f0;
            border: 1px solid #cccccc;
            border-radius: 8px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 10px;
        }
        .history-item img {
            max-width: 120px;
            max-height: 120px;
            border-radius: 8px;
            cursor: pointer;
            margin: auto;
        }
        .copy-button, .delete-button, .select-all-button {
            margin-top: 5px;
            padding: 5px 10px;
            background-color: #007bff;
            color: #ffffff;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 12px;
        }
        .copy-button:hover, .delete-button:hover, .select-all-button:hover {
            background-color: #0000ff;
        }
        .back-button {
            position: fixed;
            top: 25px;
            right: 25px;
            background: none;
            border: none;
            padding: 5px 10px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
        } 
        .pagination {
            margin-top: 20px;
            display: flex;
            gap: 5px;
            align-items: center;
        }
        .page-button {
            padding: 5px 10px;
            background-color: #007bff;
            color: #ffffff;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
        }
        .page-button:hover {
            background-color: #0000ff;
        }
        .page-input {
            width: 40px;
            text-align: center;
        }
        .toast {
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background-color: #fefefe;
            color: #333;
            padding: 10px 20px;
            border-radius: 5px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            display: none;
            z-index: 1000;
            font-size: 16px;
            opacity: 0;
            transition: opacity 0.3s ease;
        }
        .toast.show {
            opacity: 1;
        }
        @media (max-width: 600px) {
            #history-container {
                grid-template-columns: repeat(3, 1fr);
            }
        }
        @media (min-width: 601px) {
            #history-container {
                grid-template-columns: repeat(5, 1fr);
            }
        }
        .total-pages {
            font-size: 14px;
            margin: 0 10px;
        }        
        </style>
    </head>
    <body>
        <h1 id="history-title">History</h1>
        <button id="back-button" class="back-button">
        <svg xmlns="http://www.w3.org/2000/svg" fill="#888" viewBox="0 0 24 24" style="width: 20px; height: 20px; margin-right: 5px;">
            <path d="M19 11H7.414l5.293-5.293-1.414-1.414L2.586 12l8.707 8.707 1.414-1.414L7.414 13H19v-2z"/>
        </svg>
        </button>
        <div style="display: flex; gap: 10px; justify-content: center; align-items: center;">
        <button id="select-all-button" class="select-all-button">All</button>
        <button id="delete-button" class="delete-button">Delete</button>
        <select id="link-format" class="link-format">
            <option value="url">URL</option>
            <option value="md">Markdown</option>
            <option value="bbcode">BBCode</option>
        </select>
        <button id="copy-button" class="copy-button">Copy</button>        
        </div>
        <div id="history-container"></div>

        <div class="pagination">
            <button id="prev-page" class="page-button">Previous page</button>
            <input id="current-page" class="page-input" type="number" min="1" value="1">
            <span id="total-pages" class="total-pages"></span>
            <button id="next-page" class="page-button">Next page</button>
        </div>

        <div id="toast" class="toast"></div>

        <script>
        const backButton = document.getElementById('back-button');
        const historyContainer = document.getElementById('history-container');
        const toast = document.getElementById('toast');
        const deleteButton = document.getElementById('delete-button');
        const selectAllButton = document.getElementById('select-all-button');
        const prevPageButton = document.getElementById('prev-page');
        const nextPageButton = document.getElementById('next-page');
        const currentPageInput = document.getElementById('current-page');
        const totalPagesSpan = document.getElementById('total-pages');
        const urlParams = new URLSearchParams(window.location.search);
        const copyButton = document.getElementById('copy-button');
        const formatSelect = document.getElementById('link-format');
        currentPage = parseInt(urlParams.get('page')) || 1;
        let itemsPerPage = window.innerWidth <= 600 ? 12 : 15;

        document.getElementById('history-title').addEventListener('click', () => { 
            window.location.reload(); 
        }); 

        copyButton.addEventListener('click', () => {
            const selectedFormat = formatSelect.value;
            const selectedItems = Array.from(document.querySelectorAll('input[type="checkbox"]:checked'));

            if (selectedItems.length === 0) {
                showToast('Please select a picture first!');
                return;
            }

            let textToCopy = selectedItems.map(checkbox => {
                const url = checkbox.value;
                if (selectedFormat === 'url') {
                    return url;
                } else if (selectedFormat === 'md') {
                    return '![img](' + url + ')';
                } else if (selectedFormat === 'bbcode') {
                    return '[img]' + url + '[/img]';
                }
            }).join(' ');
        
            navigator.clipboard.writeText(textToCopy).then(() => {
                showToast('Links copied!');
            });
        });

        function showHistory() {
            historyContainer.innerHTML = '';
            let history = JSON.parse(localStorage.getItem('imageHistory')) || [];
            const totalItems = history.length;
            const totalPages = Math.ceil(totalItems / itemsPerPage);
            currentPage = Math.min(currentPage, totalPages);
            updateURL(currentPage);
            currentPageInput.value = currentPage;
            totalPagesSpan.textContent = currentPage + '/' + totalPages;

            const start = (currentPage - 1) * itemsPerPage;
            const end = Math.min(start + itemsPerPage, totalItems);
            const currentItems = history.slice(start, end);

            currentItems.forEach(item => {
                const historyItem = document.createElement('div');
                historyItem.classList.add('history-item');
                const url = item.url || item;
                const img = document.createElement('img');
                img.src = url;
                img.onclick = () => {
                    window.open(url, '_blank');
                };
                historyItem.appendChild(img);
        
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = url;
                historyItem.prepend(checkbox);
                historyContainer.appendChild(historyItem);
            });
        
            prevPageButton.disabled = currentPage === 1;
            nextPageButton.disabled = currentPage === totalPages;
        }

        currentPageInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                const inputPage = parseInt(currentPageInput.value, 10);
                if (!isNaN(inputPage)) {
                    const totalItems = JSON.parse(localStorage.getItem('imageHistory')).length;
                    const totalPages = Math.ceil(totalItems / itemsPerPage);
                    if (inputPage >= 1 && inputPage <= totalPages) {
                        currentPage = inputPage;
                        showHistory();
                    } else {
                        showToast('Invalid page number');
                    }
                }
            }
        });
                
        deleteButton.addEventListener('click', async () => {
            const selectedItems = Array.from(document.querySelectorAll('input[type="checkbox"]:checked')).map(checkbox => checkbox.value);
            if (selectedItems.length > 0) {
                let history = JSON.parse(localStorage.getItem('imageHistory')) || [];
                
                for (const url of selectedItems) {
                    const itemToDelete = history.find(item => (item.url === url || item === url));
                    if (itemToDelete) {
                        const xhr = new XMLHttpRequest();
                        xhr.open('DELETE', 'delete/' + itemToDelete.identifier, true);
                        
                        history = history.filter(item => item.url !== url && item !== url);
                        localStorage.setItem('imageHistory', JSON.stringify(history));
                        showToast('Pictures have been marked for deletion!');
        
                        xhr.onload = () => {
                            if (xhr.status >= 200 && xhr.status < 300) {
                                showToast('Pictures have been deleted from the server!');
                            } else {
                                console.error('Failed to delete:', xhr.statusText);
                                showToast('Error deleting image from server: ' + xhr.statusText);
                            }
                        };
                        
                        xhr.onerror = () => {
                            console.error('Request failed');
                            showToast('Request failed');
                        };
                        
                        xhr.send();
                    }
                }
                showHistory();
            } else {
                showToast('Please select the pictures you want to delete first!');
            }
        });

        selectAllButton.addEventListener('click', () => {
            const checkboxes = document.querySelectorAll('#history-container input[type="checkbox"]');
            checkboxes.forEach(checkbox => {
                checkbox.checked = true;
            });
        });

        function updateURL(page) {
            const url = new URL(window.location);
            url.searchParams.set('page', page);
            window.history.pushState({}, '', url);
        }
        
        showHistory();

        prevPageButton.addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                showHistory();
                updateURL(currentPage);
            }
        });
        
        nextPageButton.addEventListener('click', () => {
            const totalItems = JSON.parse(localStorage.getItem('imageHistory')).length;
            const totalPages = Math.ceil(totalItems / itemsPerPage);
            if (currentPage < totalPages) {
                currentPage++;
                showHistory();
                updateURL(currentPage);
            }
        });

        const toastQueue = [];

        function showToast(message) {
            toastQueue.push(message);
            if (toastQueue.length === 1) {
                displayNextToast();
            }
        }
        
        function displayNextToast() {
            if (toastQueue.length === 0) return;
        
            const message = toastQueue[0];
            toast.textContent = message;
            toast.classList.add('show');
            toast.style.display = 'block';
        
            setTimeout(() => {
                toast.classList.remove('show');
                setTimeout(() => {
                    toast.style.display = 'none';
                    toastQueue.shift();
                    displayNextToast();
                }, 500);
            }, 3000);
        }

        function updateItemsPerPage() {
            itemsPerPage = window.innerWidth <= 600 ? 12 : 15;
            showHistory();
        }

        window.addEventListener('resize', updateItemsPerPage);

        showHistory();

        backButton.addEventListener('click', () => {
            window.location.href = '/';
        });
        </script>
        </body>
        </html>
    `;
}

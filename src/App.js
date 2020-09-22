import React from 'react';
import { Button, message, Progress, Table, Space } from 'antd';
import './app.css';
const SIZE = 10 * 1024 * 1024; // 切片大小
const columns = [
  {
    title: '切片hash',
    dataIndex: 'hash',
    key: 'hash',
    width: '30%',
  },
  {
    title: '大小(KB)',
    dataIndex: 'size',
    key: 'size',
    width: '10%',
  },
  {
    title: '进度',
    dataIndex: 'percentage',
    key: 'percentage',
    render: (text, record) => {
      return (
        <Progress percent={text} />
      )
    }
  },
];

class App extends React.Component {
  constructor(props) {
    super(props);
    this.container = {
      file: null
    }
    this.requestList = []
    this.state = {
      data: [],
      requestList: [],
      hashPercentage: 0,
      fakeUploadPercentage: 0
    }
  }
  componentDidUpdate = () => {
    const now = this.uploadPercentage();
    if (now !== this.state.fakeUploadPercentage) {
      this.setState({ fakeUploadPercentage: now });
    }
  }
  uploadPercentage = () => {
    if (!this.container.file || !this.state.data.length) return 0;
    const loaded = this.state.data
      .map(item => item.size * item.percentage)
      .reduce((acc, cur) => acc + cur);
    return parseInt((loaded / this.container.file.size).toFixed(2));
  }
  handleFileChange = (e) => {
    const [file] = e.target.files;
    if (!file) return;
    this.container.file = file;
  }
  handleUpload = async () => {
    if (!this.container.file) return;
    const fileChunkList = this.createFileChunk(this.container.file);
    this.container.hash = await this.calculateHash(fileChunkList);
    const { shouldUpload, uploadedList } = await this.verifyUpload(
      this.container.file.name,
      this.container.hash
    );
    if (!shouldUpload) {
      message.success("秒传：上传成功");
      return;
    }
    const data = fileChunkList.map(({ file }, index) => ({
      fileHash: this.container.hash,
      index,
      hash: this.container.hash + "-" + index,
      chunk: file,
      size: file.size,
      percentage: uploadedList.includes(index) ? 100 : 0
    }));
    this.setState({ data }, async () => {
      await this.uploadChunks(uploadedList);
    })
  }
  // 根据 hash 验证文件是否曾经已经被上传过
  // 没有才进行上传
  verifyUpload = async (filename, fileHash) => {
    const { data } = await this.request({
      url: "http://localhost:3001/verify",
      headers: {
        "content-type": "application/json"
      },
      data: JSON.stringify({
        filename,
        fileHash
      })
    });
    return JSON.parse(data);
  }
  // 生成文件 hash（web-worker）
  calculateHash = (fileChunkList) => {
    return new Promise(resolve => {
      this.container.worker = new Worker("/hash.js");
      this.container.worker.postMessage({ fileChunkList });
      this.container.worker.onmessage = e => {
        const { percentage, hash } = e.data;
        this.setState({ hashPercentage: percentage });
        if (hash) {
          resolve(hash);
        }
      };
    });
  }
  // 控制每次发起的请求量
  sendRequest = async (forms, max = 4) => {
    return new Promise(resolve => {
      const len = forms.length;
      let idx = 0;
      let counter = 0;
      const start = async () => {
        // 有请求，有通道
        while (idx < len && max > 0) {
          max--; // 占用通道
          console.log(idx, "start");
          const formData = forms[idx].formData;
          const index = forms[idx].index;
          idx++
          /* eslint-disable no-loop-func */
          this.request({
            url: "http://localhost:3001",
            data: formData,
            onProgress: this.createProgressHandler(this.state.data[index]),
            requestList: this.requestList
          }).then(() => {
            max++; // 释放通道
            counter++;
            if (counter === len) {
              resolve();
            } else {
              start();
            }
          });
        }
      }
      start();
    });
  }
  uploadChunks = async (uploadedList = []) => {
    const requestList = this.state.data
      .filter(({ hash }) => !uploadedList.includes(hash))
      .map(({ chunk, hash, index }) => {
        const formData = new FormData();
        formData.append("chunk", chunk);
        formData.append("hash", hash);
        formData.append("filename", this.container.file.name);
        formData.append("fileHash", this.container.hash);
        return { formData, index };
      })
    //   .map(async ({ formData, index }) =>
    //     this.request({
    //       url: "http://localhost:3001",
    //       data: formData,
    //       onProgress: this.createProgressHandler(this.state.data[index]),
    //       requestList: this.state.requestList
    //     })
    //   );
    // Promise.all一次性发送全部请求，会导致分片过多时候的卡顿
    // await Promise.all(requestList);

    // 每次只请求4个，当一个请求结束后，在请求接下来的那个
    await this.sendRequest(requestList, 4);

    // 之前上传的切片数量 + 本次上传的切片数量 = 所有切片数量时
    // 合并切片
    if (uploadedList.length + requestList.length === this.state.data.length) {
      await this.mergeRequest();
    }
  }
  mergeRequest = async () => {
    await this.request({
      url: "http://localhost:3001/merge",
      headers: {
        "content-type": "application/json"
      },
      data: JSON.stringify({
        size: SIZE,
        fileHash: this.container.hash,
        filename: this.container.file.name
      })
    });
  }
  // 生成文件切片
  createFileChunk = (file, size = SIZE) => {
    const fileChunkList = [];
    let cur = 0;
    while (cur < file.size) {
      fileChunkList.push({ file: file.slice(cur, cur + size) });
      cur += size;
    }
    return fileChunkList;
  }
  request = ({ url, method = "post", data, headers = {}, onProgress = e => e, requestList }) => {
    return new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = onProgress;
      xhr.open(method, url);
      Object.keys(headers).forEach(key =>
        xhr.setRequestHeader(key, headers[key])
      );
      xhr.send(data);
      xhr.onload = e => {
        resolve({
          data: e.target.response
        });
      };
    });
  }
  // 用闭包保存每个 chunk 的进度数据
  createProgressHandler = (item) => {
    return e => {
      item.percentage = parseInt(String((e.loaded / e.total) * 100));
      this.setState(({ data }) => {
        data[item.index].percentage = parseInt(String((e.loaded / e.total) * 100));
        return { data };
      })
    };
  }
  render() {
    const { data, hashPercentage, fakeUploadPercentage } = this.state;
    return (
      <div className="App">
        <Space>
          <input type="file" onChange={this.handleFileChange} />
          <Button type="primary" onClick={this.handleUpload}>上传</Button>
        </Space>
        <div>
          <div>计算文件 hash</div>
          <Progress percent={hashPercentage} />
          <div>总进度</div>
          <Progress percent={fakeUploadPercentage} />
          <Table columns={columns} pagination={false} dataSource={data} rowKey="index" />
        </div>
      </div>
    );
  }
}

export default App;

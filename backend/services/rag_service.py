"""
rag_service.py - RAG（檢索增強生成）框架

目前狀態：Stub 實作，retrieve() 回傳空列表。

TODO: 接入文件來源的步驟：
1. 選擇向量資料庫：
   - 本地：chromadb（已在 requirements.txt）
   - 雲端：Pinecone（pip install pinecone-client）
2. 準備文件來源：
   - 使用者日記 / 自述文字
   - 物品的相關描述（照片標籤、故事）
   - 心理學文獻（依附理論、物件關係理論）
3. 實作文件索引：
       await rag_service.index_documents(documents)
4. 在 chat router 呼叫：
       context = await rag_service.retrieve(user_message, top_k=3)
5. 將 context 傳入 GeminiService.chat() 的 rag_context 參數

參考：
- LangChain RAG 教學：https://python.langchain.com/docs/tutorials/rag/
- ChromaDB 文件：https://docs.trychroma.com/
"""

import logging
from typing import Optional

from langchain.schema import Document

logger = logging.getLogger(__name__)


class RAGService:
    """
    RAG 服務：負責文件索引與語義檢索。

    目前為 Stub，retrieve() 固定回傳空列表。
    實作時請依照 module docstring 的步驟逐步接入。
    """

    def __init__(self, collection_name: str = "drawing_to_3d"):
        """
        初始化 RAG 服務。

        Args:
            collection_name: 向量資料庫的集合名稱。
        """
        self.collection_name = collection_name
        self._initialized = False

        # TODO: 初始化向量資料庫連線
        # 範例（ChromaDB）：
        #   import chromadb
        #   self.client = chromadb.Client()
        #   self.collection = self.client.get_or_create_collection(collection_name)

        # TODO: 初始化 embedding 模型
        # 範例（使用 Google embedding）：
        #   from langchain_google_genai import GoogleGenerativeAIEmbeddings
        #   self.embeddings = GoogleGenerativeAIEmbeddings(model="models/embedding-001")

        logger.info("RAGService 初始化（Stub 模式，尚未連接向量資料庫）")

    async def index_documents(self, documents: list[Document]) -> int:
        """
        將文件加入向量資料庫。

        Args:
            documents: LangChain Document 物件列表，每個含 page_content 與 metadata。

        Returns:
            成功索引的文件數量。

        Raises:
            NotImplementedError: RAG 尚未實作。
        """
        # TODO: 實作文件向量化與索引
        # 範例：
        #   texts = [doc.page_content for doc in documents]
        #   embeddings = await self.embeddings.aembed_documents(texts)
        #   self.collection.add(...)
        raise NotImplementedError("RAG index_documents 尚未實作。請參考 module docstring。")

    async def retrieve(
        self,
        query: str,
        top_k: int = 3,
        session_id: Optional[str] = None,
    ) -> list[str]:
        """
        根據查詢語句檢索最相關的文件段落。

        Args:
            query: 查詢語句（通常為使用者訊息）。
            top_k: 回傳的最大文件數量。
            session_id: 可選的 session ID，用於個人化檢索範圍。

        Returns:
            相關段落的字串列表。目前固定回傳空列表（Stub）。
        """
        # TODO: 實作向量語義搜尋
        # 範例：
        #   query_embedding = await self.embeddings.aembed_query(query)
        #   results = self.collection.query(query_embeddings=[query_embedding], n_results=top_k)
        #   return [doc for doc in results["documents"][0]]

        logger.debug("RAG retrieve 被呼叫（Stub 模式），query='%s'，回傳空列表", query)
        return []

    async def delete_session_documents(self, session_id: str) -> None:
        """
        刪除指定 session 的所有索引文件。

        Args:
            session_id: Session ID。

        Raises:
            NotImplementedError: RAG 尚未實作。
        """
        # TODO: 實作依 metadata.session_id 篩選刪除
        raise NotImplementedError("RAG delete_session_documents 尚未實作。")


# 模組級單例
rag_service = RAGService()

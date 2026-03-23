<?php

namespace Test\Foo\Model;

use Test\Foo\Api\StorageInterface;

class CustomerSession
{
    public function __construct(
        private StorageInterface $storage,
        private SessionManager $sessionManager,
    ) {
    }

    public function setCustomerId($id)
    {
        $this->storage->setData('customer_id', $id);
        return $this;
    }

    public function getCustomerId()
    {
        $customerId = $this->storage->getData('customer_id');
        return $customerId;
    }

    public function getSessionName()
    {
        return $this->sessionManager->getCustomerId();
    }

    public function startSession()
    {
        $this->storage->init();
        $this->sessionManager->start();
    }
}
